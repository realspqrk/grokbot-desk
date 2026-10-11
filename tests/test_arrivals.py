"""Beta 2: dedupe_key, a created stamp in the future, results --since,
paths, and one attention request per burst of pushes."""
import io
import json
import os
import threading
import time
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

import core.cli as cli
import core.server as server_module
from conftest import ROOT
from core.envelope import EnvelopeError, validate_payload
from core.paths import ensure_layout, load_config
from core.registry import scan_registry
from core.server import Handler, ReportHTTPServer
from test_safety import request, valid_payload


@pytest.fixture
def live(tmp_path):
    data_dir = ensure_layout(tmp_path / "data")
    server = ReportHTTPServer(
        ("127.0.0.1", 0), Handler, data_dir,
        scan_registry(ROOT / "templates"), load_config(data_dir),
    )
    server.port = server.server_port
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def push(payload):
        status, body = request(
            server.port, "POST", "/push", json.dumps(payload).encode(),
            {"Host": f"127.0.0.1:{server.port}", "X-RS-Token": server.token,
             "Content-Type": "application/json"},
        )
        return status, json.loads(body)

    server.push = push
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()


def test_dedupe_key_returns_the_open_run_instead_of_a_second_one(live):
    first = dict(valid_payload(), dedupe_key="capterra-audit-2026-10-11")
    status, one = live.push(first)
    assert status == 200 and "deduped" not in one
    status, two = live.push(dict(first, title="Pushed again"))
    assert status == 200
    assert (two["run_id"], two["deduped"], two["state"]) == (one["run_id"], True, "open")
    assert live.runs.open_count() == 1
    # another bot, or another key, is a new run
    status, other = live.push(dict(first, bot="other-agent"))
    assert other["run_id"] != one["run_id"] and "deduped" not in other


def test_dedupe_key_returns_a_run_decided_within_the_window(live):
    payload = dict(valid_payload(), dedupe_key="reply-drafts", dedupe_hours=6)
    _, one = live.push(payload)
    live.runs.decide(one["run_id"], "cancelled")
    _, two = live.push(payload)
    assert (two["run_id"], two["deduped"], two["state"]) == (one["run_id"], True, "cancelled")


def test_an_expired_run_is_not_a_duplicate(live):
    payload = dict(valid_payload(), dedupe_key="weekly")
    _, one = live.push(payload)
    live.runs.decide(one["run_id"], "expired")
    _, two = live.push(payload)
    assert two["run_id"] != one["run_id"] and "deduped" not in two


@pytest.mark.parametrize("bad", [
    {"dedupe_key": ""}, {"dedupe_key": " lead"}, {"dedupe_key": "x" * 121},
    {"dedupe_key": "ok", "dedupe_hours": 0}, {"dedupe_key": "ok", "dedupe_hours": 169},
    {"dedupe_hours": 3},
])
def test_dedupe_fields_are_validated(bad):
    registry = scan_registry(ROOT / "templates")
    with pytest.raises(EnvelopeError):
        validate_payload(dict(valid_payload(), **bad), registry)


def test_a_created_stamp_in_the_future_is_clamped_with_a_warning():
    registry = scan_registry(ROOT / "templates")
    ahead = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat(timespec="seconds")
    warnings = []
    payload = validate_payload(dict(valid_payload(), created=ahead), registry, warnings=warnings)
    created = datetime.fromisoformat(payload["created"])
    assert abs((created - datetime.now(timezone.utc)).total_seconds()) < 5
    assert len(warnings) == 1 and "/created" in warnings[0]
    # a minute ahead (clock skew) is left alone
    near = (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat(timespec="seconds")
    warnings = []
    assert validate_payload(dict(valid_payload(), created=near), registry, warnings=warnings)["created"] == near
    assert warnings == []


def test_push_answers_the_clamp_warning(live):
    ahead = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(timespec="seconds")
    status, body = live.push(dict(valid_payload(), created=ahead))
    assert status == 200 and "clamped" in body["warnings"][0]


def test_attention_once_per_burst(live):
    assert live.attention_due(now=100.0) is True
    assert all(live.attention_due(now=100.0 + 5 * i) is False for i in range(1, 6))
    assert live.attention_due(now=125.0 + server_module.ATTENTION_QUIET_S) is True


def test_a_burst_of_pushes_requests_attention_once(live):
    with patch.object(server_module, "request_attention") as attention, \
            patch.object(live.hub, "probe_window", return_value=True):
        for index in range(6):
            bot = "inbox-agent" if index % 2 else "social-agent"
            assert live.push(dict(valid_payload(), bot=bot, title=f"R{index}"))[0] == 200
    assert attention.call_count == 1


def _run(command, base, **kwargs):
    stream = io.StringIO()
    with redirect_stdout(stream):
        code = command(SimpleNamespace(**kwargs), base) if kwargs else command(base)
    return code, json.loads(stream.getvalue())


def test_results_since_lists_new_decisions_oldest_first(live):
    start = datetime.now(timezone.utc) - timedelta(seconds=2)
    _, a = live.push(dict(valid_payload(), bot="inbox-agent"))
    _, b = live.push(dict(valid_payload(), bot="social-agent"))
    live.runs.decide(a["run_id"], "cancelled")
    live.runs.decide(b["run_id"], "cancelled")
    code, out = _run(cli.command_results, live.data_dir, since=start.isoformat(), bot=None, wait=0)
    assert code == 0 and out["data_dir"] == str(live.data_dir)
    assert [item["run_id"] for item in out["results"]] == [a["run_id"], b["run_id"]]
    code, out = _run(cli.command_results, live.data_dir, since=start.isoformat(), bot="social-agent", wait=0)
    assert [item["run_id"] for item in out["results"]] == [b["run_id"]]
    assert out["cursor"] == out["results"][-1]["decided"] and out["seen"] == [b["run_id"]]
    code, out = _run(
        cli.command_results, live.data_dir, since=out["cursor"], bot=None, wait=0, seen=out["seen"]
    )
    assert b["run_id"] not in [item["run_id"] for item in out["results"]]


def _decided(base, run_id, stamp, bot="inbox-agent"):
    (base / "results" / f"{run_id}.json").write_text(json.dumps({
        "run_id": run_id, "bot": bot, "template": "decide-list",
        "status": "submitted", "decided": stamp,
    }), encoding="utf-8")


def _round_trip(base, answer, **extra):
    return _run(cli.command_results, base, since=answer["cursor"], bot=None,
                wait=extra.get("wait", 0), seen=answer["seen"])[1]


def test_results_since_round_trip_never_loses_or_repeats_a_same_second_decision(tmp_path):
    """`decided` has whole seconds. Passing `cursor` and `seen` back as they
    came must list a late decision in the cursor's own second once, and never
    list an earlier one again."""
    base = ensure_layout(tmp_path / "data")
    second = "2026-10-11T11:00:00+02:00"
    _decided(base, "run-a", second)
    code, out = _run(cli.command_results, base, since=second, bot=None, wait=0)
    assert code == 0 and [i["run_id"] for i in out["results"]] == ["run-a"]
    assert out["cursor"] == second and out["seen"] == ["run-a"]
    _decided(base, "run-b", second)  # later, in the same second
    out = _round_trip(base, out)
    assert [i["run_id"] for i in out["results"]] == ["run-b"]
    assert out["cursor"] == second and sorted(out["seen"]) == ["run-a", "run-b"]
    out = _round_trip(base, out)
    assert out["results"] == [] and out["cursor"] == second
    assert sorted(out["seen"]) == ["run-a", "run-b"], "an empty answer keeps the state"
    later = "2026-10-11T11:00:01+02:00"
    _decided(base, "run-c", later)
    out = _round_trip(base, out)
    assert [i["run_id"] for i in out["results"]] == ["run-c"]
    assert out["cursor"] == later and out["seen"] == ["run-c"], "the cursor advanced"
    out = _round_trip(base, out)
    assert out["results"] == []


def test_results_wait_skips_seen_runs_instead_of_returning_at_once(tmp_path):
    base = ensure_layout(tmp_path / "data")
    second = "2026-10-11T11:00:00+02:00"
    _decided(base, "run-a", second)
    began = time.monotonic()
    out = _run(cli.command_results, base, since=second, bot=None, wait=0.6, seen=["run-a"])[1]
    assert out["results"] == [] and time.monotonic() - began >= 0.5


def test_results_empty_answer_without_any_result_echoes_the_cursor(tmp_path):
    base = ensure_layout(tmp_path / "data")
    out = _run(cli.command_results, base, since="2026-10-11T11:00:00+02:00", bot=None, wait=0)[1]
    assert out == {"data_dir": str(base), "results": [], "cursor": "2026-10-11T11:00:00+02:00", "seen": []}


def _open_run(base, run_id, expires):
    (base / "runs" / f"{run_id}.json").write_text(
        json.dumps({"state": "open", "expires": expires.isoformat(timespec="seconds")}),
        encoding="utf-8",
    )


def _wait(base, run_id, **options):
    args = SimpleNamespace(run_id=run_id, timeout=options.get("timeout", 0),
                           until_expiry=options.get("until_expiry", False))
    with redirect_stdout(io.StringIO()), patch.object(cli, "error", side_effect=lambda m, c: c):
        return cli.command_wait(args, base)


def test_wait_ends_at_expiry_plus_grace_with_exit_7(tmp_path):
    base = ensure_layout(tmp_path / "data")
    now = datetime.now(timezone.utc)
    _open_run(base, "r1", now - timedelta(seconds=cli.WAIT_EXPIRY_GRACE_S + 5))
    assert _wait(base, "r1") == 7
    assert _wait(base, "r1", until_expiry=True) == 7
    assert _wait(base, "r1", timeout=30) == 7
    assert not (base / "results" / "r1.json").exists(), "wait never writes a result"


def test_wait_timeout_before_expiry_still_exits_5(tmp_path):
    base = ensure_layout(tmp_path / "data")
    _open_run(base, "r2", datetime.now(timezone.utc) + timedelta(hours=1))
    assert _wait(base, "r2", timeout=0.3) == 5


def test_wait_until_expiry_returns_the_result_when_it_lands(tmp_path):
    base = ensure_layout(tmp_path / "data")
    _open_run(base, "r3", datetime.now(timezone.utc) + timedelta(hours=1))
    result = base / "results" / "r3.json"
    timer = threading.Timer(0.4, lambda: result.write_text(json.dumps({"status": "submitted"}), encoding="utf-8"))
    timer.start()
    try:
        assert _wait(base, "r3", until_expiry=True) == 0
    finally:
        timer.cancel()


def test_wait_until_expiry_and_timeout_exclude_each_other(tmp_path):
    base = ensure_layout(tmp_path / "data")
    _open_run(base, "r4", datetime.now(timezone.utc) + timedelta(hours=1))
    assert _wait(base, "r4", timeout=5, until_expiry=True) == 2


def test_results_since_rejects_a_stamp_without_offset(tmp_path):
    base = ensure_layout(tmp_path / "data")
    stream = io.StringIO()
    with redirect_stdout(stream), patch.object(cli, "error", return_value=2) as error:
        assert cli.command_results(SimpleNamespace(since="2026-10-11 09:00", bot=None, wait=0), base) == 2


def test_paths_and_result_name_the_data_dir_in_use(live):
    code, out = _run(cli.command_paths, live.data_dir)
    assert out["data_dir"] == str(live.data_dir) and out["results"].endswith("results")
    _, one = live.push(valid_payload())
    live.runs.decide(one["run_id"], "cancelled")
    code, out = _run(cli.command_result, live.data_dir, run_id=one["run_id"])
    assert out["data_dir"] == str(live.data_dir) and out["status"] == "cancelled"


def test_wait_returns_7_only_after_a_future_deadline(tmp_path):
    base = ensure_layout(tmp_path / "data")
    now = datetime.now(timezone.utc).replace(microsecond=0)
    _open_run(base, "r5", now)
    with patch.object(cli, "WAIT_EXPIRY_GRACE_S", 1.5):
        began = time.monotonic()
        assert _wait(base, "r5", until_expiry=True) == 7
        assert time.monotonic() - began >= 0.4, "it waited for the deadline"


def test_wait_result_at_the_deadline_wins_over_exit_7(tmp_path):
    base = ensure_layout(tmp_path / "data")
    _open_run(base, "r6", datetime.now(timezone.utc) - timedelta(seconds=cli.WAIT_EXPIRY_GRACE_S + 5))
    (base / "results" / "r6.json").write_text(json.dumps({"status": "expired"}), encoding="utf-8")
    assert _wait(base, "r6", until_expiry=True) == 0


@pytest.mark.parametrize("record", ['{"state": "open"}', "{not json"])
def test_wait_without_a_readable_expiry_keeps_the_timeout(tmp_path, record):
    """An old record without `expires` (or an unreadable one) has no expiry
    deadline: a timeout still ends the wait with exit 5 (documented)."""
    base = ensure_layout(tmp_path / "data")
    (base / "runs" / "r7.json").write_text(record, encoding="utf-8")
    assert _wait(base, "r7", timeout=0.3) == 5


@pytest.mark.parametrize("argv", [
    ["wait", "r8", "--until-expiry", "--timeout", "0"],
    ["wait", "r8", "--timeout", "5", "--until-expiry"],
])
def test_wait_parser_rejects_until_expiry_with_any_timeout(argv):
    with redirect_stdout(io.StringIO()), patch("sys.stderr", io.StringIO()), pytest.raises(SystemExit) as stop:
        cli.build_parser().parse_args(argv)
    assert stop.value.code == 2


def test_docs_teach_the_same_wait_flow():
    """README, GUIDE and SKILL give a bot one flow: a short wait first, a
    background waiter only where the runtime wakes on it, never --timeout 0,
    catch-up with results --since, and an acknowledgement."""
    for name in ("README.md", "docs/GUIDE.md", "skills/grokbot-desk/SKILL.md"):
        text = (ROOT / name).read_text(encoding="utf-8")
        for needle in ("--timeout 60", "--until-expiry", "background shells may not wake",
                       "`--timeout 0`", "results --since", "topic + OK"):
            assert needle.lower() in text.lower(), (name, needle)
        assert "--timeout 120" not in text, name
