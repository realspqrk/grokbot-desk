import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

import core.server as server_module
import core.timeutil as timeutil
from core.actionlog import ActionLog
from core.paths import ensure_layout, load_config
from core.runs import RunStore


ROOT = __import__("pathlib").Path(__file__).resolve().parents[1]


def _clock_probe(anchor=None, sleep_seconds=0):
    env = dict(os.environ)
    if anchor is None:
        env.pop("RS_CLOCK_ANCHOR", None)
    else:
        env["RS_CLOCK_ANCHOR"] = anchor
    code = (
        "import json, time; from core.timeutil import local_now; "
        "first=local_now(); "
        f"time.sleep({sleep_seconds!r}); "
        "second=local_now(); "
        "print(json.dumps([first.isoformat(), second.isoformat()]))"
    )
    return subprocess.run(
        [sys.executable, "-c", code],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )


def test_clock_anchor_unset_uses_real_clock():
    before = datetime.now(timezone.utc)
    probe = _clock_probe()
    after = datetime.now(timezone.utc)
    assert probe.returncode == 0, probe.stderr
    first, _ = json.loads(probe.stdout)
    observed = datetime.fromisoformat(first).astimezone(timezone.utc)
    assert before <= observed <= after


def test_clock_anchor_valid_sets_requested_instant():
    probe = _clock_probe("2026-10-08T10:40:00Z")
    assert probe.returncode == 0, probe.stderr
    first, _ = json.loads(probe.stdout)
    observed = datetime.fromisoformat(first).astimezone(timezone.utc)
    anchor = datetime(2026, 10, 8, 10, 40, tzinfo=timezone.utc)
    assert anchor <= observed < anchor + timedelta(seconds=1)


def test_clock_anchor_advances_with_real_elapsed_time():
    probe = _clock_probe("2026-10-08T10:40:00+00:00", sleep_seconds=0.05)
    assert probe.returncode == 0, probe.stderr
    first, second = map(datetime.fromisoformat, json.loads(probe.stdout))
    assert 0.03 <= (second - first).total_seconds() < 1


def test_clock_anchor_invalid_fails_with_clear_error():
    probe = _clock_probe("not-an-instant")
    assert probe.returncode != 0
    assert "RS_CLOCK_ANCHOR must be an ISO 8601 instant with an offset" in probe.stderr


def test_without_a_pinned_zone_times_use_the_machines_own_zone(monkeypatch):
    monkeypatch.delenv("RS_TZ", raising=False)
    for value in ("2026-01-08T10:00:00Z", "2026-07-08T10:00:00+01:00"):
        expected = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone()
        assert timeutil.to_local(value) == expected
        assert timeutil.to_local(value).utcoffset() == expected.utcoffset()
    assert timeutil.zone_name() is None


def test_a_pinned_zone_wins_and_an_unknown_one_falls_back_to_the_machine(monkeypatch):
    monkeypatch.setenv("RS_TZ", "UTC")
    assert timeutil.to_local("2026-07-08T10:00:00+02:00").isoformat() == "2026-07-08T08:00:00+00:00"
    monkeypatch.setenv("RS_TZ", "../etc/passwd")
    assert timeutil.zone_name() is None
    monkeypatch.setenv("RS_TZ", "Mars/Olympus_Mons")
    expected = datetime(2026, 7, 8, 8, tzinfo=timezone.utc).astimezone()
    assert timeutil.to_local("2026-07-08T08:00:00Z").utcoffset() == expected.utcoffset()


def test_z_and_explicit_offset_convert_to_local():
    assert timeutil.to_local("2026-01-08T10:00:00Z").isoformat() == "2026-01-08T11:00:00+01:00"
    assert timeutil.to_local("2026-07-08T10:00:00+01:00").isoformat() == "2026-07-08T11:00:00+02:00"


def test_dst_boundaries_both_directions():
    assert timeutil.to_local("2026-03-29T00:59:59Z").utcoffset().total_seconds() == 3600
    assert timeutil.to_local("2026-03-29T01:00:00Z").utcoffset().total_seconds() == 7200
    assert timeutil.to_local("2026-10-25T00:59:59Z").utcoffset().total_seconds() == 7200
    assert timeutil.to_local("2026-10-25T01:00:00Z").utcoffset().total_seconds() == 3600


def test_fallback_when_zoneinfo_raises(monkeypatch):
    monkeypatch.setattr(timeutil, "ZoneInfo", lambda name: (_ for _ in ()).throw(RuntimeError()))
    summer = timeutil.to_local("2026-07-01T12:00:00Z")
    winter = timeutil.to_local("2026-01-01T12:00:00Z")
    assert summer.utcoffset().total_seconds() == 7200
    assert winter.utcoffset().total_seconds() == 3600


def test_format_and_offset_required():
    assert timeutil.format_local("2026-10-08T10:39:00+02:00") == "Do 08.10.2026 · 10:39"
    with pytest.raises(ValueError):
        timeutil.to_local("2026-10-08T10:39:00")
    assert timeutil.local_now().tzinfo is not None


@pytest.mark.parametrize(
    ("created", "before", "due", "expected_expires"),
    [
        (
            "2026-03-29T01:30:00+01:00",
            "2026-03-29T03:29:59+02:00",
            "2026-03-29T03:30:00+02:00",
            "2026-03-29T03:30:00+02:00",
        ),
        (
            "2026-10-25T02:30:00+02:00",
            "2026-10-25T02:29:59+01:00",
            "2026-10-25T02:30:00+01:00",
            "2026-10-25T02:30:00+01:00",
        ),
    ],
)
@pytest.mark.parametrize("fallback", [False, True])
def test_run_expiry_and_duration_use_elapsed_utc_across_dst(
    tmp_path, monkeypatch, created, before, due, expected_expires, fallback
):
    if fallback:
        monkeypatch.setattr(
            timeutil, "ZoneInfo", lambda name: (_ for _ in ()).throw(RuntimeError())
        )
    data_dir = ensure_layout(tmp_path / "data")
    store = RunStore(
        data_dir,
        load_config(data_dir),
        ActionLog(data_dir),
    )
    run_id = "20261025-023000-test-abcd"
    store.register(
        {
            "schema": "grokbot-desk/payload@2", "ask": "read",
            "run_id": run_id,
            "bot": "example-dev-bot",
            "title": "DST",
            "created": created,
            "expires_minutes": 60,
            "blocks": [{"type": "text", "id": "b1", "md": "Hello"}],
        }
    )
    assert store.detail(run_id)["expires"] == expected_expires
    with patch("core.runs.local_now", return_value=timeutil.to_local(before)):
        assert store.expire_due() == []
    with patch("core.runs.local_now", return_value=timeutil.to_local(due)):
        assert store.expire_due() == [run_id]
    result = json.loads((data_dir / "results" / f"{run_id}.json").read_text())
    assert result["duration_s"] == 3600


def test_submitted_run_detail_exposes_immutable_result_for_read_only_reopen(tmp_path):
    data_dir = ensure_layout(tmp_path / "data")
    store = RunStore(
        data_dir,
        load_config(data_dir),
        ActionLog(data_dir),
    )
    run_id = "20261008-120000-reopen-abcd"
    store.register(
        {
            "schema": "grokbot-desk/payload@2", "ask": "read",
            "run_id": run_id,
            "bot": "example-dev-bot",
            "title": "Reopen",
            "created": "2026-10-08T12:00:00+02:00",
            "expires_minutes": 60,
            "blocks": [{"type": "text", "id": "b1", "md": "Hello"}],
        }
    )
    store.decide(run_id, "submitted", {"decision": "read", "note": "Gesendete Notiz"})

    detail = store.detail(run_id)
    assert detail["state"] == "submitted"
    assert detail["result"] == {"decision": "read", "note": "Gesendete Notiz", "refs": []}


@pytest.mark.parametrize(
    ("older", "newer"),
    [
        ("2026-10-08T14:00:00+05:00", "2026-10-08T10:00:00Z"),
        ("2026-10-25T02:30:00+02:00", "2026-10-25T02:15:00+01:00"),
    ],
)
def test_finding_7_run_summaries_sort_by_instant_across_offsets(
    tmp_path, older, newer
):
    data_dir = ensure_layout(tmp_path / "data")
    store = RunStore(
        data_dir,
        load_config(data_dir),
        ActionLog(data_dir),
    )
    for label, created in (("older", older), ("newer", newer)):
        store.register(
            {
                "schema": "grokbot-desk/payload@2", "ask": "read",
                "run_id": f"20261008-120000-{label}-abcd",
                "bot": "example-dev-bot",
                "title": label,
                "created": created,
                "expires_minutes": 240,
                "blocks": [{"type": "text", "id": "b1", "md": "Hello"}],
            }
        )
    assert [item["title"] for item in store.summaries({})] == [
        "newer",
        "older",
    ]


def test_registration_seq_survives_reload_and_ignores_a_skewed_clock(tmp_path):
    """seq is assigned at registration and kept on the run record."""
    data_dir = ensure_layout(tmp_path / "data")

    def open_store():
        return RunStore(
            data_dir,
            load_config(data_dir),
            ActionLog(data_dir),
        )

    store = open_store()
    store.register({
        "schema": "grokbot-desk/payload@2", "ask": "read",
        "run_id": "20261011-120000-inbox-aaaa",
        "bot": "example-inbox-bot",
        "title": "Inbox first",
        "created": "2026-10-11T12:00:00+02:00",
        "expires_minutes": 240,
        "blocks": [{"type": "text", "id": "b1", "md": "Hello"}],
    })
    store.register({
        "schema": "grokbot-desk/payload@2", "ask": "read",
        "run_id": "20261011-120001-social-bbbb",
        "bot": "example-social-bot",
        "title": "Social skewed",
        "created": "2026-10-11T09:00:00+02:00",
        "expires_minutes": 240,
        "blocks": [{"type": "text", "id": "b1", "md": "Hello"}],
    })
    listed = {item["title"]: item for item in store.summaries({})}
    assert listed["Inbox first"]["seq"] == 1
    assert listed["Social skewed"]["seq"] == 2
    reloaded = open_store()
    third = reloaded.register({
        "schema": "grokbot-desk/payload@2", "ask": "read",
        "run_id": "20261011-120002-inbox-cccc",
        "bot": "example-inbox-bot",
        "title": "Inbox later",
        "created": "2026-10-11T08:00:00+02:00",
        "expires_minutes": 240,
        "blocks": [{"type": "text", "id": "b1", "md": "Hello"}],
    })
    assert third["run_id"]
    again = {item["title"]: item["seq"] for item in reloaded.summaries({})}
    assert again == {"Inbox first": 1, "Social skewed": 2, "Inbox later": 3}
    record = reloaded._runs["20261011-120000-inbox-aaaa"]
    del record["seq"]
    reloaded._save(record)
    legacy = reloaded.summaries({})
    bare = next(item for item in legacy if item["title"] == "Inbox first")
    assert "seq" not in bare


def test_legacy_records_keep_created_order_ahead_of_later_registrations(tmp_path):
    """A saved run without seq is numbered on load, in created order, before later ones."""
    data_dir = ensure_layout(tmp_path / "data")

    def open_store():
        return RunStore(
            data_dir,
            load_config(data_dir),
            ActionLog(data_dir),
        )

    store = open_store()

    def add(run_id, bot, title, created):
        store.register({
            "schema": "grokbot-desk/payload@2", "ask": "read",
            "run_id": run_id,
            "bot": bot,
            "title": title,
            "created": created,
            "expires_minutes": 240,
            "blocks": [{"type": "text", "id": "b1", "md": "Hello"}],
        })

    add("20261011-100000-inbox-aaaa", "example-inbox-bot", "Inbox older", "2026-10-11T10:00:00+02:00")
    add("20261011-100001-inbox-bbbb", "example-inbox-bot", "Inbox newer", "2026-10-11T12:00:00+02:00")
    add("20261011-100002-social-cccc", "example-social-bot", "Social skewed", "2026-10-11T08:00:00+02:00")
    for run_id in ("20261011-100000-inbox-aaaa", "20261011-100001-inbox-bbbb"):
        record = store._runs[run_id]
        del record["seq"]
        store._save(record)
    reloaded = open_store()
    order = {item["title"]: item["seq"] for item in reloaded.summaries({})}
    assert order["Inbox older"] < order["Inbox newer"] < order["Social skewed"]
    assert json.loads(
        (data_dir / "runs" / "20261011-100000-inbox-aaaa.json").read_text(encoding="utf-8")
    )["seq"] == order["Inbox older"]
    reloaded.register({
        "schema": "grokbot-desk/payload@2", "ask": "read",
        "run_id": "20261011-100003-inbox-dddd",
        "bot": "example-inbox-bot",
        "title": "Inbox after",
        "created": "2026-10-11T07:00:00+02:00",
        "expires_minutes": 240,
        "blocks": [{"type": "text", "id": "b1", "md": "Hello"}],
    })
    again = {item["title"]: item["seq"] for item in reloaded.summaries({})}
    assert again["Inbox after"] > again["Social skewed"]


class _Stopping:
    def __init__(self):
        self.was_set = False

    def set(self):
        self.was_set = True


class _LifecycleServer:
    def __init__(self, open_runs, subscribers):
        self.open_runs = open_runs
        self.subscribers = subscribers
        self.idle_since = None
        self.stopping = _Stopping()
        self.shutdowns = 0
        self.broadcasts = []

        class Runs:
            def __init__(inner):
                inner.expire = []

            def expire_due(inner):
                expired = inner.expire
                inner.expire = []
                if expired:
                    self.open_runs = 0
                return expired

            def open_count(inner):
                return self.open_runs

        class Hub:
            def has_subscribers(inner):
                return self.subscribers

        self.runs = Runs()
        self.hub = Hub()

    def broadcast_runs(self, run_id, state):
        self.broadcasts.append((run_id, state))

    def shutdown(self):
        self.shutdowns += 1


def test_idle_shutdown_starts_30_minutes_after_last_run_expires():
    server = _LifecycleServer(open_runs=1, subscribers=False)
    server.runs.expire = ["run"]
    assert not server_module._maintenance_tick(server, 100)
    assert server.idle_since == 100
    assert server.broadcasts == [("run", "expired")]
    assert not server_module._maintenance_tick(server, 1899)
    assert server_module._maintenance_tick(server, 1900)
    assert server.shutdowns == 1


def test_idle_shutdown_starts_30_minutes_after_last_subscriber_leaves():
    server = _LifecycleServer(open_runs=0, subscribers=True)
    assert not server_module._maintenance_tick(server, 100)
    assert server.idle_since is None
    server.subscribers = False
    assert not server_module._maintenance_tick(server, 200)
    assert server.idle_since == 200
    assert not server_module._maintenance_tick(server, 1999)
    assert server_module._maintenance_tick(server, 2000)


def test_the_browser_gets_only_the_zone_python_uses(monkeypatch):
    from core.page import build_page
    from core.paths import ROOT

    def boot_tz():
        page = build_page("c", 18920)
        return json.loads(page.split('id="rs-boot"', 1)[1].split(">", 1)[1].split("</script>", 1)[0])["tz"]

    monkeypatch.setenv("RS_TZ", "UTC")
    assert boot_tz() == "UTC"
    monkeypatch.setattr(timeutil, "ZoneInfo", lambda name: (_ for _ in ()).throw(RuntimeError()))
    # no tz data: Python falls back to the machine zone, and so must the page
    monkeypatch.setenv("RS_TZ", "America/New_York")
    assert timeutil.effective_zone_name() is None
    assert boot_tz() is None
    # the EU rule fallback and UTC still match the named zone
    monkeypatch.setenv("RS_TZ", "Europe/Vienna")
    assert boot_tz() == "Europe/Vienna"
    monkeypatch.setenv("RS_TZ", "Etc/UTC")
    assert boot_tz() == "Etc/UTC"
