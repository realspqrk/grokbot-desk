"""The upgrade to payload@2: open reports from before it expire once at desk
start (reason "upgrade") so their bots ask again; decided ones stay readable."""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

import core.cli as cli
import core.server as server_module
from conftest import free_port
from core import doorbell
from core.paths import ensure_layout, load_config
from core.runs import RunStore
from core.server import Handler, ReportHTTPServer
from test_arrivals import _run
from test_doorbell import KEY, URL, FakeBell, events

OLD = "20261011-090000-old-abcd"
STAMP = "2026-10-11T09:30:00+02:00"
V1 = {"schema": "report-shell/payload@1", "template": "decide-list", "version": 1, "bot": "old-bot",
      "title": "Old", "created": "2026-10-11T09:00:00+02:00", "data": {}}


def old_run(data_dir, run_id=OLD, state="open"):
    (data_dir / "runs" / f"{run_id}.json").write_text(json.dumps({
        "payload": dict(V1, run_id=run_id), "state": state, "expires": "2026-10-11T13:00:00+02:00",
    }), encoding="utf-8")


def start(data_dir):
    """A desk start: load the store, then expire what the upgrade ends."""
    server = ReportHTTPServer(("127.0.0.1", free_port()), Handler, data_dir, load_config(data_dir))
    bell = FakeBell()
    server.runs.doorbell = doorbell.Doorbell(data_dir, server.action_log, opener=bell, sleep=lambda s: None)
    server.bell = bell
    return server


def result_of(data_dir, run_id=OLD):
    return json.loads((data_dir / "results" / f"{run_id}.json").read_text(encoding="utf-8"))


@pytest.fixture
def data_dir(tmp_path):
    base = ensure_layout(tmp_path / "data")
    doorbell.save(base, URL, KEY)
    return base


def test_open_v1_run_expires_once_on_start(data_dir):
    old_run(data_dir)
    server = start(data_dir)
    try:
        assert server.runs.expire_legacy() == [OLD]
        server.runs.doorbell.join()
        result = result_of(data_dir)
        assert (result["schema"], result["status"], result["run_id"], result["bot"]) == (
            "grokbot-desk/result@2", "expired", OLD, "old-bot")
        assert [e["detail"] for e in events(data_dir, "expire")] == [{"reason": "upgrade"}]
        assert [(b["run_id"], b["status"]) for b in server.bell.bodies()] == [(OLD, "expired")]
        assert server.runs.open_count() == 0 and not server.runs.has(OLD)
        assert server.runs.expire_legacy() == []
    finally:
        server.server_close()
    # a restart finds the record decided: no second result, no second ring
    before = (data_dir / "results" / f"{OLD}.json").read_bytes()
    again = start(data_dir)
    try:
        assert again.runs.expire_legacy() == []
        again.runs.doorbell.join()
        assert again.bell.bodies() == []
        assert (data_dir / "results" / f"{OLD}.json").read_bytes() == before
        assert json.loads((data_dir / "runs" / f"{OLD}.json").read_text(encoding="utf-8"))["state"] == "expired"
    finally:
        again.server_close()


def test_the_desk_start_runs_the_upgrade(data_dir, monkeypatch):
    old_run(data_dir)
    monkeypatch.setattr(ReportHTTPServer, "serve_forever", lambda self, poll_interval=.5: None)
    server_module._serve(data_dir, free_port())
    assert result_of(data_dir)["status"] == "expired"


def test_submitted_v1_result_still_readable_by_result_and_results(data_dir):
    old_run(data_dir, state="submitted")
    legacy = {"schema": "report-shell/result@1", "run_id": OLD, "bot": "old-bot", "status": "submitted",
              "decided": STAMP, "data": {"decision": "approve"}}
    (data_dir / "results" / f"{OLD}.json").write_text(json.dumps(legacy), encoding="utf-8")
    server = start(data_dir)
    try:
        assert server.runs.expire_legacy() == []
    finally:
        server.server_close()
    assert result_of(data_dir) == legacy
    code, out = _run(cli.command_result, data_dir, run_id=OLD)
    assert code == 0 and out["status"] == "submitted" and out["data"] == {"decision": "approve"}
    code, out = _run(cli.command_results, data_dir, since="2026-10-11T00:00:00+02:00", bot=None, wait=0)
    assert [item["run_id"] for item in out["results"]] == [OLD]


def test_results_since_returns_upgrade_expiry_exactly_once(data_dir):
    old_run(data_dir)
    start_at = (datetime.now(timezone.utc) - timedelta(seconds=2)).isoformat()
    server = start(data_dir)
    try:
        server.runs.expire_legacy()
    finally:
        server.server_close()
    code, out = _run(cli.command_results, data_dir, since=start_at, bot=None, wait=0)
    assert [(i["run_id"], i["status"]) for i in out["results"]] == [(OLD, "expired")]
    code, again = _run(cli.command_results, data_dir, since=out["cursor"], bot=None, wait=0, seen=out["seen"])
    assert again["results"] == []
    code, one = _run(cli.command_result, data_dir, run_id=OLD)
    assert one["status"] == "expired"


def test_interrupted_upgrade_resumes(data_dir, monkeypatch):
    old_run(data_dir)
    crashing = start(data_dir)
    try:
        def crash(self, record):
            raise OSError("disk went away")
        with monkeypatch.context() as patch:
            patch.setattr(RunStore, "_save", crash)
            assert crashing.runs.expire_legacy() == []
        # the result was written, the record still says open
        written = (data_dir / "results" / f"{OLD}.json").read_bytes()
        assert json.loads((data_dir / "runs" / f"{OLD}.json").read_text(encoding="utf-8"))["state"] == "open"
    finally:
        crashing.server_close()
    restarted = start(data_dir)
    try:
        assert restarted.runs.expire_legacy() == []  # no second result
        restarted.runs.doorbell.join()
        assert (data_dir / "results" / f"{OLD}.json").read_bytes() == written
        assert json.loads((data_dir / "runs" / f"{OLD}.json").read_text(encoding="utf-8"))["state"] == "expired"
        # the ring the crash cost happens now, once
        assert [(b["run_id"], b["status"]) for b in restarted.bell.bodies()] == [(OLD, "expired")]
    finally:
        restarted.server_close()
    third = start(data_dir)
    try:
        third.runs.expire_legacy()
        third.runs.doorbell.join()
        assert third.bell.bodies() == []
    finally:
        third.server_close()
