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
from conftest import ROOT, show_fixture
from core.envelope import EnvelopeError, validate_payload
from core.paths import ensure_layout, load_config
from core.payload import ResultError
from core.server import Handler, ReportHTTPServer
from test_safety import request, valid_payload


@pytest.fixture
def live(tmp_path):
    data_dir = ensure_layout(tmp_path / "data")
    server = ReportHTTPServer(
        ("127.0.0.1", 0), Handler, data_dir,
        load_config(data_dir),
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
    with pytest.raises(EnvelopeError):
        validate_payload(dict(valid_payload(), **bad))


def test_a_created_stamp_in_the_future_is_clamped_with_a_warning():
    ahead = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat(timespec="seconds")
    warnings = []
    payload = validate_payload(dict(valid_payload(), created=ahead), warnings=warnings)
    created = datetime.fromisoformat(payload["created"])
    assert abs((created - datetime.now(timezone.utc)).total_seconds()) < 5
    assert len(warnings) == 1 and "/created" in warnings[0]
    # a minute ahead (clock skew) is left alone
    near = (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat(timespec="seconds")
    warnings = []
    assert validate_payload(dict(valid_payload(), created=near), warnings=warnings)["created"] == near
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
    assert out["results"][0]["title"] == "Safety test"
    assert "summary" not in out["results"][0]
    code, out = _run(cli.command_results, live.data_dir, since=start.isoformat(), bot="social-agent", wait=0)
    assert [item["run_id"] for item in out["results"]] == [b["run_id"]]
    assert out["cursor"] == out["results"][-1]["decided"] and out["seen"] == [b["run_id"]]
    code, out = _run(
        cli.command_results, live.data_dir, since=out["cursor"], bot=None, wait=0, seen=out["seen"]
    )
    assert b["run_id"] not in [item["run_id"] for item in out["results"]]


def _decided(base, run_id, stamp, bot="inbox-agent"):
    (base / "results" / f"{run_id}.json").write_text(json.dumps({
        "run_id": run_id, "bot": bot,
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


STAMP = "2026-10-11T11:00:00+02:00"


def _stored(base, run_id, payload):
    """A run record as the desk saves it, and its payload."""
    stored = validate_payload(dict(payload, run_id=run_id))
    stored.pop("identity", None)
    (base / "runs" / f"{run_id}.json").write_text(json.dumps({"payload": stored}), encoding="utf-8")
    return stored


def _submitted(base, run_id, data, bot="inbox-agent"):
    (base / "results" / f"{run_id}.json").write_text(json.dumps({
        "schema": "grokbot-desk/result@2", "run_id": run_id, "bot": bot,
        "status": "submitted", "decided": STAMP, "data": data,
    }), encoding="utf-8")


RUN_IDS = {name: f"20261011-110000-{name}-abcd" for name in ("list", "post", "one", "pick", "manual")}


def _post(ask, platforms):
    return show_fixture("approve-post", ask=ask, blocks=[{
        "type": "post", "id": "post", "author": {"name": "Shop", "handle": "shop"},
        "text": "Hello.", "hashtags": [], "platforms": platforms,
    }])


def test_results_since_carries_a_title_and_a_compact_summary(tmp_path):
    """A one-line ack needs the topic, and a summary of what the person decided."""
    base = ensure_layout(tmp_path / "data")
    _stored(base, RUN_IDS["list"], show_fixture("approve-decide", title="Three invoices need a decision"))
    _submitted(base, RUN_IDS["list"], {"decision": "submit", "note": "", "refs": [], "blocks": {"invoices": {"items": [
        {"id": "hosting", "choice": "approve"}, {"id": "toner", "choice": "later"},
        {"id": "parking", "choice": "approve"},
    ]}}})
    _stored(base, RUN_IDS["post"], _post("approve", ["x", "linkedin"]))
    _submitted(base, RUN_IDS["post"], {"decision": "approve", "note": "", "refs": [], "blocks": {"post": {"platforms": [
        {"platform": "x", "included": False}, {"platform": "linkedin", "included": True},
    ]}}}, bot="social-bot")
    _stored(base, RUN_IDS["manual"], _post("do", ["x", "linkedin"]))
    _submitted(base, RUN_IDS["manual"], {"decision": "submit", "note": "", "refs": [], "blocks": {"post": {"platforms": [
        {"platform": "x", "choice": "posted"}, {"platform": "linkedin", "choice": "skipped"},
    ]}}}, bot="social-bot")
    _stored(base, RUN_IDS["pick"], show_fixture("choose"))
    _submitted(base, RUN_IDS["pick"], {"decision": "choose", "note": "", "refs": [], "blocks": {"date": {"choice": "thu"}}})
    _submitted(base, RUN_IDS["one"], {"decision": "approve", "note": "", "refs": []})
    code, out = _run(cli.command_results, base, since=STAMP, bot=None, wait=0)
    assert code == 0
    by_id = {item["run_id"]: item for item in out["results"]}
    listed = by_id[RUN_IDS["list"]]
    assert listed["title"] == "Three invoices need a decision"
    assert listed["summary"] == "submit · 2 approve, 1 later"
    assert list(listed) == ["run_id", "bot", "title", "status", "decided", "result_path", "summary"]
    post = by_id[RUN_IDS["post"]]
    assert post["summary"] == "approve · linkedin" and post["bot"] == "social-bot"
    assert by_id[RUN_IDS["manual"]]["summary"] == "submit · x posted, linkedin skipped"
    assert by_id[RUN_IDS["pick"]]["summary"] == "choose thu"
    # no run record left: no title and no summary (nothing to read the data against)
    one = by_id[RUN_IDS["one"]]
    assert "summary" not in one and "title" not in one


def test_a_summary_never_reads_a_result_that_does_not_answer_its_report(tmp_path):
    """A summary never calls a platform approved that the answer does not include."""
    base = ensure_layout(tmp_path / "data")
    _stored(base, "20261011-110000-post-abcd", _post("approve", ["x", "linkedin"]))
    broken = [
        {"decision": "approve", "blocks": {"post": {"platforms": [{"platform": "x", "choice": "posted"}]}}},
        {"decision": "approve", "blocks": {"post": {"platforms": [{"platform": "x", "included": True}]}}},
        {"decision": "approve"},
        {"decision": "approve", "platforms": ["linkedin"], "comment": "",
         "per_platform": {"linkedin": {"mode": "auto", "decision": "approved"}}},
    ]
    for index, data in enumerate(broken):
        run_id = f"20261011-110000-bad{index}-abcd"
        _stored(base, run_id, _post("approve", ["x", "linkedin"]))
        _submitted(base, run_id, data, bot="social-agent")
    # a result of a payload@1 report: readable, never summarised
    (base / "runs" / "legacy-run.json").write_text(json.dumps({"payload": {
        "schema": "report-shell/payload@1", "template": "preview-post", "run_id": "legacy-run", "title": "Old",
    }}), encoding="utf-8")
    (base / "results" / "legacy-run.json").write_text(json.dumps({
        "schema": "report-shell/result@1", "run_id": "legacy-run", "bot": "social-agent", "template": "preview-post",
        "status": "submitted", "decided": STAMP,
        "data": {"decision": "approve", "platforms": ["linkedin"], "comment": "",
                 "per_platform": {"linkedin": {"mode": "auto", "decision": "approved"}}},
    }), encoding="utf-8")
    code, out = _run(cli.command_results, base, since=STAMP, bot=None, wait=0)
    assert code == 0 and len(out["results"]) == len(broken) + 1
    for item in out["results"]:
        assert "summary" not in item, item["run_id"]
    assert {item["title"] for item in out["results"]} == {"Post: autumn opening hours", "Old"}


def test_results_poll_returns_a_valid_result_beside_malformed_ones(tmp_path):
    """Malformed data (wrong types anywhere) is left unsummarised and the poll still returns."""
    base = ensure_layout(tmp_path / "data")
    _stored(base, "20261011-110000-valid-abcd", _post("approve", ["linkedin"]))
    _submitted(base, "20261011-110000-valid-abcd", {"decision": "approve", "blocks": {"post": {"platforms": [
        {"platform": "linkedin", "included": True}]}}})
    malformed = [[], {}, None, 1, 1.0, "approve", {"decision": []}, {"decision": "approve", "blocks": []},
                 {"decision": "approve", "blocks": {"post": {"platforms": [{"platform": [], "included": True}]}}},
                 {"decision": "approve", "blocks": {"post": {"platforms": [{"platform": "linkedin", "included": "yes"}]}}}]
    for index, data in enumerate(malformed):
        run_id = f"20261011-110000-bad{index}-abcd"
        _stored(base, run_id, _post("approve", ["linkedin"]))
        _submitted(base, run_id, data)
    code, out = _run(cli.command_results, base, since=STAMP, bot=None, wait=0)
    assert code == 0
    by_id = {item["run_id"]: item for item in out["results"]}
    assert len(by_id) == len(malformed) + 1
    assert by_id["20261011-110000-valid-abcd"]["summary"] == "approve · linkedin"
    for run_id, item in by_id.items():
        if run_id != "20261011-110000-valid-abcd":
            assert "summary" not in item


def test_submit_rejects_a_result_that_does_not_answer_the_report(live):
    detail = live.runs.register(validate_payload(_post("approve", ["x", "linkedin"])))
    with pytest.raises(ResultError) as error:
        live.runs.decide(detail["run_id"], "submitted", {"decision": "approve", "blocks": {"post": {"platforms": [
            {"platform": "x", "choice": "posted"}, {"platform": "linkedin", "included": True}]}}})
    assert error.value.pointer == "/data/blocks/post/platforms/0/choice"
    assert live.runs.detail(detail["run_id"])["state"] == "open"
    live.runs.decide(detail["run_id"], "submitted", {"decision": "approve", "blocks": {"post": {"platforms": [
        {"platform": "x", "included": True}, {"platform": "linkedin", "included": False}]}}})
    saved = json.loads((live.runs.results_dir / f"{detail['run_id']}.json").read_text(encoding="utf-8"))
    assert saved["schema"] == "grokbot-desk/result@2" and "template" not in saved
    assert saved["data"] == {"decision": "approve", "note": "", "refs": [], "blocks": {"post": {"platforms": [
        {"platform": "x", "included": True}, {"platform": "linkedin", "included": False}]}}}


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
    """GUIDE and SKILL give a bot one flow: a short foreground wait, the
    doorbell when it is on, catch-up with results --since, never --timeout 0,
    and an acknowledgement. The README points at the skill and does not
    teach that flow."""
    for name in ("docs/GUIDE.md", "skills/grokbot-desk/SKILL.md"):
        text = (ROOT / name).read_text(encoding="utf-8")
        for needle in ("--timeout 60", "`--timeout 0`", "results --since",
                       "topic + OK", "Desk:", "doorbell"):
            assert needle.lower() in text.lower(), (name, needle)
        assert "--timeout 120" not in text, name
        assert "background shells may not wake" not in text.lower(), name
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    assert "skills/grokbot-desk/SKILL.md" in readme
    assert "--timeout 120" not in readme


def test_marking_a_read_run_read_again_does_not_rewrite_it(live):
    """Each window focus posts /read. Only the first marks the run read and
    saves it; later ones change nothing and must not queue another fsync
    under the store lock that every API read waits on."""
    detail = live.runs.register(validate_payload(valid_payload()))
    run_id = detail["run_id"]
    saved = []
    original = live.runs._save

    def counting(record):
        saved.append(record["payload"]["run_id"])
        original(record)

    with patch.object(live.runs, "_save", side_effect=counting):
        for _ in range(5):
            live.runs.mark_read(run_id)
    assert saved == [run_id]
    on_disk = json.loads((live.runs.runs_dir / f"{run_id}.json").read_text(encoding="utf-8"))
    assert on_disk["unread"] is False


# ------------------------------------------------ payload@2 over the API ----


def _api(live, path):
    status, body = request(live.port, "GET", path, headers={
        "Host": f"127.0.0.1:{live.port}", "X-RS-CSRF": live.csrf,
    })
    return status, json.loads(body)


def test_api_run_serves_the_payload_without_its_internals(live):
    status, pushed = live.push(show_fixture("approve-decide", dedupe_key="invoices-w43", urgent=True))
    assert status == 200
    status, detail = _api(live, f"/api/run/{pushed['run_id']}")
    assert status == 200
    for gone in ("schema", "dedupe_key", "dedupe_hours", "expires_minutes", "template", "data", "task"):
        assert gone not in detail, gone
    assert detail["run_id"] == pushed["run_id"] and detail["ask"] == "approve"
    assert detail["title"] == "Two invoices this week" and detail["why"] == "Hosting is due Friday."
    assert detail["urgent"] is True and detail["due"] == "2026-10-23"
    assert [block["id"] for block in detail["blocks"]] == ["b1", "invoices"]
    assert detail["state"] == "open" and detail["expires"]
    assert detail["identity"]["name"] == "Office Bot" and "accent" in detail["identity"]
    assert detail["bot"] == "office-bot" and detail["bot_display"] == "Office Bot"
    assert "result" not in detail
    status, runs = _api(live, "/api/runs")
    (summary,) = runs["runs"]
    assert {"run_id", "title", "ask", "urgent", "due", "bot", "bot_display", "identity", "unread", "seq"} <= set(summary)
    assert (summary["ask"], summary["urgent"], summary["due"]) == ("approve", True, "2026-10-23")
    assert "template" not in summary and "task" not in summary


def test_submit_over_http_checks_the_answer_against_the_report(live):
    _, pushed = live.push(show_fixture("approve-decide"))
    headers = {
        "Host": f"127.0.0.1:{live.port}", "Origin": f"http://127.0.0.1:{live.port}",
        "X-RS-CSRF": live.csrf, "Content-Type": "application/json",
    }
    half = {"decision": "submit", "blocks": {"invoices": {"items": [{"id": "hosting", "choice": "approve"}]}}}
    status, body = request(live.port, "POST", "/submit",
                           json.dumps({"run_id": pushed["run_id"], "data": half}).encode(), headers)
    assert status == 400
    assert json.loads(body)["pointer"] == "/data/blocks/invoices/items"
    full = {"decision": "submit", "note": "Toner: ask for a cheaper vendor first.",
            "refs": [{"block": "invoices", "item": "toner", "label": "Toner, 132.90 EUR"}],
            "blocks": {"invoices": {"items": [
                {"id": "hosting", "choice": "approve"}, {"id": "toner", "choice": "later"},
                {"id": "parking", "choice": "reject"}]}}}
    status, _ = request(live.port, "POST", "/submit",
                        json.dumps({"run_id": pushed["run_id"], "data": full}).encode(), headers)
    assert status == 200
    status, detail = _api(live, f"/api/run/{pushed['run_id']}")
    assert detail["state"] == "submitted" and detail["result"]["refs"] == full["refs"]


def test_a_payload_1_record_is_skipped_with_a_log_line_and_keeps_its_run_id(tmp_path):
    data_dir = ensure_layout(tmp_path / "data")
    old_id = "20261011-090000-old-abcd"
    (data_dir / "runs" / f"{old_id}.json").write_text(json.dumps({
        "payload": {"schema": "report-shell/payload@1", "template": "decide-list", "version": 1,
                    "run_id": old_id, "bot": "old-bot", "title": "Old", "created": "2026-10-11T09:00:00+02:00",
                    "data": {}},
        "state": "open", "expires": "2026-10-11T13:00:00+02:00",
    }), encoding="utf-8")
    server = ReportHTTPServer(("127.0.0.1", 0), Handler, data_dir, load_config(data_dir))
    try:
        assert not server.runs.has(old_id) and server.runs.open_count() == 0
        events = [json.loads(line) for path in (data_dir / "log").glob("*.jsonl")
                  for line in path.read_text(encoding="utf-8").splitlines()]
        assert any(event["run_id"] == old_id and event["detail"] == {"what": "run_skipped", "reason": "payload@1"}
                   for event in events)
        # the old run's id stays taken: its record is not overwritten
        with pytest.raises(ValueError, match="already used"):
            server.runs.register(validate_payload(dict(valid_payload(), run_id=old_id)))
    finally:
        server.server_close()
