"""The doorbell: after every decision the bot did not cause, the desk POSTs
one short message to the webhook set up once per device, so the asking bot
wakes up. Contract tests against the real server and CLI; only the outbound
HTTPS request is faked (opener and sleep are the module's own seams)."""
import http.client
import io
import json
import os
import stat
import subprocess
import sys
import threading
import time
import urllib.error
from argparse import Namespace
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from conftest import free_port
from core import cli, doorbell
from core.actionlog import ActionLog
from core.envelope import EnvelopeError, validate_payload
from core.paths import ensure_layout, load_config
from core.server import Handler, ReportHTTPServer, _write_state as write_state

ROOT = Path(__file__).resolve().parents[1]
KEY = "fake-doorbell-key-7f3a9c"
URL = "https://hooks.example.test/doorbell/abc"


class _Response:
    def __init__(self, status, text):
        self.status = status
        self._body = io.BytesIO(text.encode("utf-8"))

    def read(self, size=-1):
        return self._body.read(size)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class FakeBell:
    """Answers each POST with the next (status, text), or raises it."""

    def __init__(self, answers=(), on_request=None):
        self.answers = list(answers)
        self.requests = []
        self.on_request = on_request

    def __call__(self, request, timeout=None):
        self.requests.append(request)
        if self.on_request:
            self.on_request(request)
        answer = self.answers.pop(0) if self.answers else (200, "ok")
        if isinstance(answer, Exception):
            raise answer
        status, text = answer
        if 200 <= status < 300:
            return _Response(status, text)
        raise urllib.error.HTTPError(
            request.full_url, status, "error", {}, io.BytesIO(text.encode("utf-8"))
        )

    def bodies(self):
        return [json.loads(request.data) for request in self.requests]


def payload(**extra):
    value = {
        "schema": "grokbot-desk/payload@2",
        "bot": "night-owl",
        "title": "Ship the release",
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "ask": "approve",
        "action": "ship",
        "blocks": [{"type": "checks", "items": [{"label": "Tests", "state": "ok"}]}],
    }
    value.update(extra)
    return value


def events(data_dir, name=None):
    found = [
        json.loads(line)
        for path in (Path(data_dir) / "log").glob("*.jsonl")
        for line in path.read_text(encoding="utf-8").splitlines()
    ]
    return [item for item in found if name is None or item["event"] == name]


def log_text(data_dir):
    return "".join(
        path.read_text(encoding="utf-8") for path in (Path(data_dir) / "log").glob("*.jsonl")
    )


@pytest.fixture
def desk(tmp_path):
    data_dir = ensure_layout(tmp_path / "data")
    port = free_port()
    server = ReportHTTPServer(
        ("127.0.0.1", port), Handler, data_dir,
        load_config(data_dir),
    )
    bell = FakeBell()
    sleeps = []
    server.runs.doorbell = doorbell.Doorbell(
        data_dir, server.action_log, opener=bell, sleep=sleeps.append
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def call(method, path, body=None, csrf=True):
        headers = {"Host": f"127.0.0.1:{port}", "Content-Type": "application/json"}
        if csrf:
            headers["X-RS-CSRF"] = server.csrf
            headers["Origin"] = f"http://127.0.0.1:{port}"
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
        raw = None if body is None else json.dumps(body).encode("utf-8")
        connection.request(method, path, body=raw, headers=headers)
        response = connection.getresponse()
        text = response.read().decode("utf-8")
        connection.close()
        return response.status, json.loads(text) if text else None, text

    def push(value):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
        connection.request("POST", "/push", body=json.dumps(value).encode("utf-8"), headers={
            "Host": f"127.0.0.1:{port}", "X-RS-Token": server.token,
            "Content-Type": "application/json",
        })
        response = connection.getresponse()
        answer = json.loads(response.read())
        connection.close()
        assert response.status == 200, answer
        return answer

    server.call, server.push, server.bell, server.sleeps = call, push, bell, sleeps
    server.data = data_dir
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()


def switch_on(data_dir):
    doorbell.save(data_dir, URL, KEY)


def test_rings_after_the_person_submits_with_who_and_what(desk):
    switch_on(desk.data)
    written = []
    desk.bell.on_request = lambda request: written.append(
        (desk.data / "results" / f"{json.loads(request.data)['run_id']}.json").is_file()
    )
    run = desk.push(payload(identity={"name": "Night Owl"}))
    status, _, _ = desk.call("POST", "/submit", {
        "run_id": run["run_id"], "data": {"decision": "approve", "note": ""},
    })
    assert status == 200
    desk.runs.doorbell.join()
    assert desk.bell.bodies() == [{
        "bot": "night-owl", "bot_name": "Night Owl", "run_id": run["run_id"],
        "status": "submitted", "title": "Ship the release",
    }]
    request = desk.bell.requests[0]
    assert request.full_url == URL
    assert request.get_header("Authorization") == f"Bearer {KEY}"
    assert written == [True], "the result is written before the doorbell rings"
    assert [e["detail"] for e in events(desk.data, "doorbell_ok")] == [{"attempt": 1}]


def test_bot_name_is_the_payload_name_never_a_registry_name(desk):
    switch_on(desk.data)
    (desk.data / "bots.json").write_text(json.dumps({"night-owl": {"name": "Registry Owl"}}), encoding="utf-8")
    run = desk.push(payload())
    assert desk.call("POST", "/cancel", {"run_id": run["run_id"]})[0] == 200
    desk.runs.doorbell.join()
    assert desk.runs.detail(run["run_id"])["bot_display"] == "Registry Owl"
    assert [body["bot_name"] for body in desk.bell.bodies()] == ["night-owl"]


def test_rings_when_the_person_discards_and_when_a_report_expires(desk):
    switch_on(desk.data)
    discarded = desk.push(payload())
    assert desk.call("POST", "/cancel", {"run_id": discarded["run_id"]})[0] == 200
    old = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(timespec="seconds")
    expired = desk.push(payload(created=old, expires_minutes=5, title="Too late"))
    assert desk.runs.expire_due() == [expired["run_id"]]
    desk.runs.doorbell.join()
    assert [(b["run_id"], b["status"], b["bot_name"]) for b in desk.bell.bodies()] == [
        (discarded["run_id"], "cancelled", "night-owl"),
        (expired["run_id"], "expired", "night-owl"),
    ]


def test_the_bots_own_cancel_stays_silent(desk):
    switch_on(desk.data)
    run = desk.push(payload())
    args = Namespace(run_id=run["run_id"])
    with redirect_stdout(io.StringIO()) as printed:
        assert cli.command_cancel(args, desk.data, desk.port) == 0
    assert json.loads(printed.getvalue())["status"] == "cancelled"
    assert (desk.data / "results" / f"{run['run_id']}.json").is_file()
    desk.runs.doorbell.join()
    assert desk.bell.requests == []


def test_setup_switches_the_one_open_window_instead_of_opening_another(desk, monkeypatch):
    write_state(desk)
    sent, launched, focused = [], [], []
    broadcast = desk.hub.broadcast
    monkeypatch.setattr(desk.hub, "broadcast", lambda event, data: (sent.append((event, data)), broadcast(event, data)))
    monkeypatch.setattr(desk.hub, "probe_window", lambda: True)
    monkeypatch.setattr(cli, "_launch_window_once", lambda *args, **kwargs: launched.append(args))
    monkeypatch.setattr(cli, "focus_window", lambda *args: focused.append(args))
    args = Namespace(action="setup", url=None, key_stdin=False)
    with redirect_stdout(io.StringIO()) as printed:
        assert cli.command_doorbell(args, desk.data, desk.port) == 0
    assert json.loads(printed.getvalue())["opened"] is False
    assert sent == [("page", {"page": "doorbell"})]
    assert launched == [] and len(focused) == 1


def first_events(port, query=""):
    """The initial event-stream block a new page receives."""
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    connection.request("GET", "/events?sid=" + "a" * 32 + query, headers={"Host": f"127.0.0.1:{port}"})
    response = connection.getresponse()
    text = b""
    while b"event: runs" not in text or not text.endswith(b"\n\n"):
        text += response.fp.read1(65536)
    connection.close()
    return text.decode("utf-8")


def test_setup_during_a_starting_launch_lands_that_window_on_the_setup_page(desk, monkeypatch):
    """No window connected yet (an ordinary launch still starting, PENDING):
    the window that connects next opens on the setup page; one window only."""
    write_state(desk)
    launched = []
    monkeypatch.setattr(cli, "_launch_window_once", lambda *args: launched.append(args) or cli.WindowLaunchStatus.PENDING)
    monkeypatch.setattr(cli, "focus_window", lambda *args: pytest.fail("no window to focus"))
    args = Namespace(action="setup", url=None, key_stdin=False)
    with redirect_stdout(io.StringIO()) as printed:
        assert cli.command_doorbell(args, desk.data, desk.port) == 0
    assert json.loads(printed.getvalue())["pending"] is True
    assert len(launched) == 1
    assert "event: page" in first_events(desk.port)
    assert "event: page" not in first_events(desk.port), "one window gets it, once"


def test_silent_while_the_doorbell_is_off(desk):
    run = desk.push(payload())
    assert desk.call("POST", "/cancel", {"run_id": run["run_id"]})[0] == 200
    desk.runs.doorbell.join()
    assert desk.bell.requests == []
    assert events(desk.data, "doorbell_ok") == events(desk.data, "doorbell_fail") == []


def bell_with(tmp_path, answers):
    data_dir = ensure_layout(tmp_path / "data")
    switch_on(data_dir)
    fake, sleeps = FakeBell(answers), []
    bell = doorbell.Doorbell(data_dir, ActionLog(data_dir), opener=fake, sleep=sleeps.append)
    bell.ring("r1", {"bot": "b", "bot_name": "b", "run_id": "r1", "status": "submitted", "title": "t"})
    bell.join()
    return data_dir, fake, sleeps


def test_retries_a_rate_limit_400_and_a_server_error_then_delivers(tmp_path):
    data_dir, fake, sleeps = bell_with(tmp_path, [
        (400, '{"error":"Grok Bot Rate Limit 18000 per minute"}'), (503, ""), (200, "ok"),
    ])
    assert len(fake.requests) == 3
    assert sleeps == [2, 4]
    assert [e["detail"] for e in events(data_dir, "doorbell_ok")] == [{"attempt": 3}]


def test_stops_at_once_on_a_refused_key(tmp_path):
    data_dir, fake, sleeps = bell_with(tmp_path, [(401, "unauthorized")])
    assert len(fake.requests) == 1 and sleeps == []
    assert [e["detail"] for e in events(data_dir, "doorbell_fail")] == [
        {"error": "HTTP 401", "attempts": 1}
    ]


def test_gives_up_after_the_backoff_and_never_logs_the_key(tmp_path):
    failure = urllib.error.URLError(f"connection refused (sent {KEY})")
    data_dir, fake, sleeps = bell_with(tmp_path, [failure] * 20)
    assert sleeps == [2, 4, 8, 16, 30, 60, 60, 60]
    assert len(fake.requests) == 9
    [fail] = events(data_dir, "doorbell_fail")
    assert fail["detail"]["attempts"] == 9
    assert KEY not in log_text(data_dir)


def test_the_setup_page_saves_rings_a_test_and_never_returns_the_key(desk):
    status, value, _ = desk.call("GET", "/api/doorbell")
    assert (status, value) == (200, {"on": False, "host": None})
    assert desk.call("POST", "/doorbell", {"url": URL, "key": KEY}, csrf=False)[0] == 403
    status, value, _ = desk.call("POST", "/doorbell", {"url": "http://hooks.example.test/x", "key": KEY})
    assert status == 400 and value == {"error": "invalid_url", "pointer": "/url"}
    status, value, _ = desk.call("POST", "/doorbell", {"url": URL, "key": "  "})
    assert status == 400 and value == {"error": "missing_key", "pointer": "/key"}
    status, value, _ = desk.call("POST", "/doorbell", {"url": URL, "key": "two words"})
    assert status == 400 and value == {"error": "invalid_key", "pointer": "/key"}
    assert not (desk.data / "doorbell.json").exists()

    texts = []
    status, value, text = desk.call("POST", "/doorbell", {"url": URL, "key": KEY})
    texts.append(text)
    assert status == 200
    assert value["on"] is True and value["host"] == "hooks.example.test"
    assert value["test"] == {"ok": True, "http_status": 200}
    assert json.loads((desk.data / "doorbell.json").read_text(encoding="utf-8")) == {"url": URL, "key": KEY}
    if os.name == "posix":
        assert stat.S_IMODE((desk.data / "doorbell.json").stat().st_mode) == 0o600
    assert desk.bell.bodies() == [{"status": "test"}]

    desk.bell.answers = [(401, "bad key")]
    status, value, text = desk.call("POST", "/doorbell/test", {})
    texts.append(text)
    assert status == 200 and value["test"] == {"ok": False, "http_status": 401, "category": "refused"}
    desk.bell.answers = [urllib.error.URLError("[WinError 10061] raw socket text")]
    status, value, text = desk.call("POST", "/doorbell/test", {})
    texts.append(text)
    assert value["test"] == {"ok": False, "http_status": None, "category": "unreachable"}
    assert "10061" not in text
    status, value, text = desk.call("GET", "/api/doorbell")
    texts.append(text)
    assert value == {"on": True, "host": "hooks.example.test"}
    assert all(KEY not in text for text in texts)
    assert KEY not in log_text(desk.data)


def test_a_test_ring_names_only_the_grok_bot_it_is_for(tmp_path):
    data_dir = ensure_layout(tmp_path / "data")
    switch_on(data_dir)
    fake = FakeBell([(202, ""), (200, "")])
    bell = doorbell.Doorbell(data_dir, ActionLog(data_dir), opener=fake)
    assert bell.test("Night Owl") == {"ok": True, "http_status": 202}
    assert bell.test()["ok"] is True
    assert fake.bodies() == [{"status": "test", "bot_name": "Night Owl"}, {"status": "test"}]


@pytest.mark.parametrize(("answer", "category"), [
    ((401, ""), "refused"), ((404, ""), "refused"), ((429, ""), "busy"), ((502, ""), "busy"),
    ((400, "Rate limit reached"), "busy"), ((400, "bad body"), "other"),
    (urllib.error.URLError("down"), "unreachable"),
])
def test_a_failed_ring_names_a_stable_category(tmp_path, answer, category):
    data_dir = ensure_layout(tmp_path / "data")
    switch_on(data_dir)
    assert doorbell.Doorbell(data_dir, None, opener=FakeBell([answer])).test()["category"] == category


def test_closing_the_desk_ends_a_backoff_and_rings_no_more(tmp_path):
    data_dir = ensure_layout(tmp_path / "data")
    switch_on(data_dir)
    fake = FakeBell([(503, "")])
    bell = doorbell.Doorbell(data_dir, ActionLog(data_dir), opener=fake)
    bell.ring("r1", {"status": "submitted"})
    deadline = time.monotonic() + 5
    while not fake.requests and time.monotonic() < deadline:
        time.sleep(.01)
    started = time.monotonic()
    bell.close()
    assert time.monotonic() - started < 1, "the 2 s backoff ends at close"
    assert not bell._worker.is_alive()
    assert bell.ring("r2", {"status": "submitted"}) is False
    time.sleep(.3)
    assert len(fake.requests) == 1
    assert events(data_dir, "doorbell_ok") == []


def joined(bell, seconds=5):
    done = threading.Thread(target=bell.join, daemon=True)
    done.start()
    done.join(seconds)
    return not done.is_alive()


def test_closing_during_a_backoff_with_rings_queued_lets_join_finish(tmp_path):
    data_dir = ensure_layout(tmp_path / "data")
    switch_on(data_dir)
    fake = FakeBell([(503, "")] * 20)
    bell = doorbell.Doorbell(data_dir, ActionLog(data_dir), opener=fake)
    for index in range(5):
        assert bell.ring(f"r{index}", {"status": "submitted"})
    deadline = time.monotonic() + 5
    while not fake.requests and time.monotonic() < deadline:
        time.sleep(.01)
    bell.close()
    bell.close()
    assert joined(bell)
    assert len(fake.requests) == 1


def test_rings_racing_a_close_are_either_refused_or_drained(tmp_path):
    data_dir = ensure_layout(tmp_path / "data")
    switch_on(data_dir)
    for _ in range(5):
        bell = doorbell.Doorbell(data_dir, ActionLog(data_dir), opener=FakeBell([(503, "")] * 50))
        ringers = [
            threading.Thread(target=lambda: [bell.ring("r", {"status": "submitted"}) for _ in range(20)])
            for _ in range(4)
        ]
        for thread in ringers:
            thread.start()
        bell.close()
        for thread in ringers:
            thread.join()
        assert joined(bell)
        assert bell.ring("late", {"status": "submitted"}) is False


def test_desk_lifecycles_leave_no_doorbell_worker(tmp_path):
    data_dir = ensure_layout(tmp_path / "data")
    switch_on(data_dir)
    workers = []
    for _ in range(3):
        server = ReportHTTPServer(
            ("127.0.0.1", free_port()), Handler, data_dir,
            load_config(data_dir),
        )
        server.runs.doorbell = doorbell.Doorbell(data_dir, server.action_log, opener=FakeBell([(503, "")] * 9))
        detail = server.runs.register(validate_payload(payload()))
        server.runs.decide(detail["run_id"], "cancelled")
        workers.append(server.runs.doorbell._worker)
        server.server_close()
    assert len(workers) == 3 and not any(worker.is_alive() for worker in workers)


def test_saves_at_the_same_time_never_collide(tmp_path):
    data_dir = ensure_layout(tmp_path / "data")
    failures = []

    def save(index):
        try:
            doorbell.save(data_dir, URL, f"{KEY}-{index}")
        except Exception as error:
            failures.append(error)

    threads = [threading.Thread(target=save, args=(index,)) for index in range(16)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert failures == []
    assert doorbell.load(data_dir)["key"].startswith(KEY)
    assert [path.name for path in data_dir.iterdir() if path.suffix == ".tmp"] == []


def test_results_since_a_fractional_cursor_keeps_its_own_second(tmp_path):
    base = ensure_layout(tmp_path / "data")
    (base / "results" / "r1.json").write_text(json.dumps({
        "run_id": "r1", "bot": "b", "status": "cancelled",
        "decided": "2026-10-14T16:00:05+02:00",
    }), encoding="utf-8")
    args = Namespace(since="2026-10-14T16:00:05.750+02:00", wait=0, bot=None, seen=[])
    with redirect_stdout(io.StringIO()) as printed:
        assert cli.command_results(args, base) == 0
    assert [item["run_id"] for item in json.loads(printed.getvalue())["results"]] == ["r1"]


def test_notify_is_gone_since_payload_2_and_the_doorbell_is_the_one_wake(desk):
    switch_on(desk.data)
    with pytest.raises(EnvelopeError) as error:
        validate_payload(payload(notify={"webhook_url": "https://elsewhere.example.test/hook"}))
    assert (error.value.pointer, error.value.message) == ("/notify", "unknown field")
    answer = desk.push(payload())
    assert desk.call("POST", "/cancel", {"run_id": answer["run_id"]})[0] == 200
    desk.runs.doorbell.join()
    assert [request.full_url for request in desk.bell.requests] == [URL]


def test_an_old_webhook_block_in_config_is_ignored(tmp_path):
    data_dir = ensure_layout(tmp_path / "data")
    (data_dir / "config.json").write_text(
        json.dumps({"webhook": {"enabled": True, "allow_prefixes": ["https://x.example/"]}}),
        encoding="utf-8",
    )
    assert "webhook" not in load_config(data_dir)


def test_a_redirect_is_never_followed(tmp_path):
    hits = []

    class Redirecting(BaseHTTPRequestHandler):
        def do_POST(self):
            hits.append((self.path, self.headers.get("Authorization")))
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            self.send_response(307)
            self.send_header("Location", "/elsewhere")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args):
            pass

    port = free_port()
    server = HTTPServer(("127.0.0.1", port), Redirecting)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        status, _ = doorbell.post(
            {"url": f"http://127.0.0.1:{port}/ring", "key": KEY}, {"status": "test"}
        )
    finally:
        server.shutdown()
        server.server_close()
    assert status == 307
    assert [path for path, _ in hits] == ["/ring"]


def doorbell_cli(env, *argv, stdin=""):
    return subprocess.run(
        [sys.executable, str(ROOT / "report_shell.py"), "--port", str(env["_PORT"]), "doorbell", *argv],
        cwd=ROOT, env=env, input=stdin, capture_output=True, text=True, timeout=60,
    )


def test_cli_sets_up_tests_and_switches_off_without_ever_printing_the_key(tmp_path):
    data_dir = tmp_path / "data"
    env = dict(os.environ, RS_DATA_DIR=str(data_dir), _PORT=str(free_port()))
    outputs = []

    def run(*argv, stdin=""):
        result = doorbell_cli(env, *argv, stdin=stdin)
        outputs.append(result.stdout + result.stderr)
        return result

    bare = run()
    assert bare.returncode == 0 and json.loads(bare.stdout) == {"doorbell": "off", "host": None}
    assert run("setup", "--url", "http://hooks.example.test/x", "--key-stdin", stdin=KEY + "\n").returncode == 2
    assert run("setup", "--url", URL, "--key-stdin", stdin="\n").returncode == 2
    assert run("setup", "--url", URL, "--key-stdin", stdin=f"{KEY}\nsecond\n").returncode == 2
    assert run("setup", "--url", URL).returncode == 2
    assert not (data_dir / "doorbell.json").exists()

    done = run("setup", "--url", URL, "--key-stdin", stdin=KEY + "\n")
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout) == {"doorbell": "on", "host": "hooks.example.test"}
    assert json.loads((data_dir / "doorbell.json").read_text(encoding="utf-8"))["key"] == KEY
    assert json.loads(run().stdout) == {"doorbell": "on", "host": "hooks.example.test"}

    # nothing listens there: one POST, no retries, a non-zero exit
    refused = free_port()
    doorbell.save(data_dir, f"https://127.0.0.1:{refused}/ring", KEY)
    tested = run("test", "--to", "Night Owl")
    assert tested.returncode != 0
    answer = json.loads(tested.stdout)
    assert answer["ok"] is False and answer["http_status"] is None
    assert answer["category"] == "unreachable" and answer["error"]

    status = subprocess.run(
        [sys.executable, str(ROOT / "report_shell.py"), "--port", env["_PORT"], "status"],
        cwd=ROOT, env=env, capture_output=True, text=True, timeout=60,
    )
    assert json.loads(status.stdout)["doorbell"] == "on"
    off = run("off")
    assert off.returncode == 0 and json.loads(off.stdout)["doorbell"] == "off"
    assert not (data_dir / "doorbell.json").exists()
    assert run("test").returncode == 2
    assert all(KEY not in text for text in outputs)
