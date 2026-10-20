"""The upgrade to payload@2: open reports from before it expire once at desk
start (reason "upgrade") so their bots ask again; decided ones stay readable."""
import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

import core.cli as cli
import core.server as server_module
from conftest import free_port
from core import doorbell
from core.jsonutil import MAX_JSON_DEPTH
from core.paths import ensure_layout, load_config
from core.runs import RunStore
from core.server import Handler, ReportHTTPServer
from test_arrivals import _run
from test_doorbell import KEY, URL, FakeBell, events

OLD = "20261011-090000-old-abcd"
STAMP = "2026-10-11T09:30:00+02:00"
V1 = {"schema": "report-shell/payload@1", "template": "legacy-list", "version": 1, "bot": "old-bot",
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


@pytest.mark.parametrize("status", ["submitted", "cancelled"])
def test_decided_v1_result_still_readable_by_result_and_results(data_dir, status):
    old_run(data_dir, state=status)
    legacy = {"schema": "report-shell/result@1", "run_id": OLD, "bot": "old-bot", "status": status,
              "decided": STAMP, "data": {"decision": "approve"}}
    (data_dir / "results" / f"{OLD}.json").write_text(json.dumps(legacy), encoding="utf-8")
    server = start(data_dir)
    try:
        assert server.runs.expire_legacy() == []
    finally:
        server.server_close()
    assert result_of(data_dir) == legacy
    code, out = _run(cli.command_result, data_dir, run_id=OLD)
    assert code == 0 and out["status"] == status and out["data"] == {"decision": "approve"}
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


def test_wait_answers_an_upgrade_expired_run_like_any_expiry(data_dir):
    old_run(data_dir)
    server = start(data_dir)
    try:
        server.runs.expire_legacy()
    finally:
        server.server_close()
    code, out = _run(cli.command_wait, data_dir, run_id=OLD, timeout=1, until_expiry=False)
    assert code == 0 and out["status"] == "expired"
    assert Path(out["result_path"]) == data_dir / "results" / f"{OLD}.json"


def test_retention_does_not_delete_an_old_open_v1_run_before_the_upgrade(data_dir, monkeypatch):
    old_run(data_dir)
    old_run(data_dir, run_id="20260101-090000-gone-abcd", state="expired")
    deep = "20260101-090000-deep-abcd"
    nested = {}
    for _ in range(MAX_JSON_DEPTH - 2):  # a record one level deeper than the default limit
        nested = {"n": nested}
    (data_dir / "runs" / f"{deep}.json").write_text(json.dumps({
        "payload": dict(V1, run_id=deep, data=nested), "state": "open",
        "expires": "2026-10-11T13:00:00+02:00"}), encoding="utf-8")
    long_ago = time.time() - 40 * 86400
    for name in (OLD, "20260101-090000-gone-abcd", deep):
        os.utime(data_dir / "runs" / f"{name}.json", (long_ago, long_ago))
    monkeypatch.setattr(ReportHTTPServer, "serve_forever", lambda self, poll_interval=.5: None)
    server_module._serve(data_dir, free_port())
    assert result_of(data_dir)["status"] == "expired"
    assert result_of(data_dir, deep)["status"] == "expired"
    assert not (data_dir / "runs" / "20260101-090000-gone-abcd.json").exists()


class _LegacyDesk:
    """A desk from before payload@2 on the port: its hello names no payload
    schema, it holds an open report, and it stops on POST /stop with the
    token of its state.json, as every desk does."""

    def __init__(self, data_dir, port):
        import http.server
        import secrets
        import threading

        from core.product import RUNNER_ID

        self.token = secrets.token_urlsafe(16)
        self.calls = []
        desk = self

        class Legacy(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _answer(self, status, value):
                body = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if self.path == "/hello":
                    self._answer(200, {"runner": RUNNER_ID, "version": "1.0.0-beta.5", "pid": os.getpid(),
                                       "port": port, "open_runs": 1, "window_alive": False})
                else:
                    self._answer(404, {"error": "not_found"})

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                desk.calls.append(self.path)
                if self.headers.get("X-RS-Token") != desk.token:
                    self._answer(403, {"error": "token"})
                elif self.path == "/stop":
                    self._answer(200, {"ok": True})
                    threading.Thread(target=desk.exit, daemon=True).start()
                else:
                    # beta.5 refused every payload@2 report
                    self._answer(400, {"error": "invalid_payload"})

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Legacy)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        (data_dir / "state.json").write_text(json.dumps({
            "token": self.token, "pid": os.getpid(), "port": port, "data_dir": str(data_dir.resolve()),
        }), encoding="utf-8")
        self.thread.start()

    def exit(self):
        # as the old desk's process ends: the port closes
        self.server.shutdown()
        self.server.server_close()

    def close(self):
        if self.thread.is_alive():
            self.exit()
        self.thread.join(timeout=2)


def test_show_replaces_a_running_desk_from_before_payload_2_that_holds_an_open_report(
    tmp_path, server_guard
):
    import subprocess
    import sys
    import urllib.request

    from conftest import ROOT, show_fixture
    from core.envelope import SCHEMA

    data_dir = ensure_layout(tmp_path / "data")
    old_run(data_dir)
    port = free_port()
    env = server_guard(dict(os.environ, RS_DATA_DIR=str(data_dir)), port)
    source = tmp_path / "report.json"
    source.write_text(json.dumps(show_fixture("read")), encoding="utf-8")
    legacy = _LegacyDesk(data_dir, port)
    try:
        shown = subprocess.run(
            [sys.executable, str(ROOT / "report_shell.py"), "--port", str(port), "show", "--data", str(source),
             "--no-window"],
            cwd=ROOT, env=env, capture_output=True, timeout=60,
        )
        assert shown.returncode == 0, shown.stderr.decode("utf-8", "replace")
        assert legacy.calls == ["/stop"]
        hello = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/hello", timeout=5).read())
        assert hello["payload"] == SCHEMA and hello["open_runs"] == 1
        # the new desk ended the old report once, so its bot asks again
        assert (result_of(data_dir)["status"], result_of(data_dir)["run_id"]) == ("expired", OLD)
    finally:
        legacy.close()


def _serve(data_dir):
    import threading

    server = ReportHTTPServer(("127.0.0.1", free_port()), Handler, data_dir, load_config(data_dir))
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .05}, daemon=True)
    thread.start()

    def close():
        server.stopping.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    return server, close


def _events(port, headers, desk=None):
    """What /events sends first: the text up to the runs event, or all of it
    when the desk ends the stream at once. desk: the run id the page names."""
    import http.client

    query = "sid=" + "a" * 32 + (f"&desk={desk}" if desk is not None else "")
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    connection.request("GET", "/events?" + query, headers={"Host": f"127.0.0.1:{port}", **headers})
    response = connection.getresponse()
    text = ""
    while True:
        line = response.fp.readline().decode("utf-8")
        if not line:
            ended = True
            break
        text += line
        if text.endswith("\n\n") and "event: runs" in text:
            ended = False
            break
    connection.close()
    return text, ended


def _boot(port):
    import http.client
    import re

    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    connection.request("GET", "/", headers={"Host": f"127.0.0.1:{port}"})
    response = connection.getresponse()
    page = response.read().decode("utf-8")
    cookie = response.getheader("Set-Cookie")
    connection.close()
    assert cookie is None
    return json.loads(re.search(r'<script id="rs-boot" type="application/json">(.*?)</script>', page, re.S).group(1))


def test_a_page_from_an_earlier_desk_is_told_to_reload_and_is_no_window(data_dir):
    """A page names the desk run that served it on /events (boot.desk). One
    from an earlier run, or from before the id existed, reloads; it never
    counts as the window. A script (no browser headers) is never a page."""
    earlier, close_earlier = _serve(data_dir)
    old = _boot(earlier.port)["desk"]
    close_earlier()
    server, close = _serve(data_dir)
    port = server.port
    browser = {"Referer": f"http://127.0.0.1:{port}/?run=x", "Sec-Fetch-Mode": "cors"}
    try:
        current = _boot(port)["desk"]
        assert isinstance(current, str) and len(current) == 32 and current != old
        # another tab loaded the new page first; the old page reconnects with its own id
        text, ended = _events(port, browser, desk=old)
        assert "event: reload" in text and ended
        # a page from before the id existed (beta.5) names none, even after a root fetch
        text, ended = _events(port, browser)
        assert "event: reload" in text and ended
        text, ended = _events(port, {"Sec-Fetch-Mode": "cors"}, desk="")
        assert "event: reload" in text and ended
        assert not server.hub.has_subscribers()
        assert server.hub.probe_window() is False
        # the current page stays
        text, ended = _events(port, browser, desk=current)
        assert "event: runs" in text and "event: reload" not in text and not ended
        # a script gets the stream with or without an id
        for desk in (None, old):
            text, ended = _events(port, {}, desk=desk)
            assert "event: runs" in text and "event: reload" not in text and not ended
    finally:
        close()
