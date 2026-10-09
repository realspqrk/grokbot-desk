import http.client
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import pytest

import core.server as server_module
import core.webhook as webhook
from conftest import free_port, install_minimal_template
from core.actionlog import ActionLog
from core.cli import command_open
from core.envelope import validate_payload
from core.media import MediaError, register_media, replace_media
from core.paths import ensure_layout, load_config
from core.registry import scan_registry
from core.results import ResultExists, write_result
from core.runs import RunStore
from core.server import Handler, ReportHTTPServer
from core.timeutil import to_vienna
from core.webhook import deliver, webhook_enabled, validate_webhook_url


def _request_timeout():
    raw = os.environ.get(
        "RS_TEST_HTTP_TIMEOUT",
        os.environ.get("RS_CLI_HTTP_TIMEOUT", "2"),
    )
    try:
        value = float(raw)
    except (TypeError, ValueError):
        value = 2
    if not value > 0:
        value = 2
    return min(max(value, 1), 60)


def request(port, method, path, body=b"", headers=None):
    connection = http.client.HTTPConnection(
        "127.0.0.1", port, timeout=_request_timeout()
    )
    connection.request(method, path, body=body, headers=headers or {})
    response = connection.getresponse()
    payload = response.read()
    connection.close()
    return response.status, payload


def test_request_uses_bounded_ci_http_timeout(monkeypatch):
    seen = []

    class Response:
        status = 200

        def read(self):
            return b"{}"

    class Connection:
        def __init__(self, host, port, timeout):
            seen.append((host, port, timeout))

        def request(self, method, path, body, headers):
            pass

        def getresponse(self):
            return Response()

        def close(self):
            pass

    monkeypatch.setenv("RS_CLI_HTTP_TIMEOUT", "15")
    monkeypatch.setattr(http.client, "HTTPConnection", Connection)

    assert request(18920, "GET", "/hello") == (200, b"{}")
    assert seen == [("127.0.0.1", 18920, 15.0)]


def valid_payload():
    return {
        "schema": "report-shell/payload@1",
        "template": "_starter",
        "version": 1,
        "bot": "example-dev-bot",
        "title": "Safety test",
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "data": {"message": "Hello"},
    }


@pytest.mark.parametrize(
    ("platform", "expected"),
    [("darwin", True), ("win32", False)],
)
def test_server_reuses_addresses_only_on_posix(
    tmp_path, monkeypatch, platform, expected
):
    root = Path(__file__).resolve().parents[1]
    data_dir = ensure_layout(tmp_path / "data")
    monkeypatch.setattr(sys, "platform", platform)
    server = ReportHTTPServer(
        ("127.0.0.1", 0),
        Handler,
        data_dir,
        scan_registry(root / "templates"),
        load_config(data_dir),
    )
    try:
        assert server.allow_reuse_address is expected
        reuse = server.socket.getsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR)
        assert bool(reuse) is expected
    finally:
        server.server_close()


def test_server_construction_does_not_resolve_bind_host(tmp_path, monkeypatch):
    lookups = []

    def unexpected_lookup(host):
        lookups.append(host)
        raise AssertionError(f"unexpected hostname lookup for {host}")

    root = Path(__file__).resolve().parents[1]
    data_dir = ensure_layout(tmp_path / "data")
    monkeypatch.setattr(socket, "getfqdn", unexpected_lookup)
    monkeypatch.setattr(socket, "gethostbyaddr", unexpected_lookup)

    server = ReportHTTPServer(
        ("127.0.0.1", free_port()),
        Handler,
        data_dir,
        scan_registry(root / "templates"),
        load_config(data_dir),
    )
    try:
        assert server.server_name == "127.0.0.1"
        assert server.server_port == server.server_address[1]
        assert lookups == []
    finally:
        server.server_close()


def test_host_origin_csrf_and_token_guards(server_process):
    process, env, port = server_process(os.environ)
    state = json.loads((Path(env["RS_DATA_DIR"]) / "state.json").read_text())
    assert request(port, "GET", "/hello", headers={"Host": "evil.test"})[0] == 403
    assert request(port, "POST", "/push", b"{}", {"Host": f"127.0.0.1:{port}"})[0] == 403
    assert request(
        port,
        "POST",
        "/copy",
        b"{}",
        {"Host": f"127.0.0.1:{port}", "Origin": "http://evil.test", "X-RS-CSRF": "bad"},
    )[0] == 403
    assert state["token"]


def test_bye_requires_guards_and_validates_exact_sid_body(server_process):
    process, env, port = server_process(os.environ)
    page = request(port, "GET", "/")[1].decode("utf-8")
    marker = '<script id="rs-boot" type="application/json">'
    csrf = json.loads(page.split(marker, 1)[1].split("</script>", 1)[0])["csrf"]
    sid = "0123456789abcdef" * 2
    body = json.dumps({"sid": sid}).encode("ascii")
    valid_headers = {
        "Host": f"127.0.0.1:{port}",
        "Origin": f"http://127.0.0.1:{port}",
        "X-RS-CSRF": csrf,
        "Content-Type": "application/json",
    }
    assert request(
        port, "POST", "/bye", body, {**valid_headers, "Host": "evil.test"}
    )[0] == 403
    assert request(
        port,
        "POST",
        "/bye",
        body,
        {**valid_headers, "Origin": "http://evil.test"},
    )[0] == 403
    assert request(
        port, "POST", "/bye", body, {**valid_headers, "X-RS-CSRF": "bad"}
    )[0] == 403

    for invalid in (
        {"sid": "0" * 31},
        {"sid": "G" * 32},
        {"sid": sid, "extra": True},
    ):
        status, _ = request(
            port,
            "POST",
            "/bye",
            json.dumps(invalid).encode("ascii"),
            valid_headers,
        )
        assert status == 400
    status, response = request(port, "POST", "/bye", body, valid_headers)
    assert status == 200
    assert json.loads(response) == {"ok": True}


def test_bye_immediately_removes_subscriber_from_window_status(tmp_path):
    root = Path(__file__).resolve().parents[1]
    data_dir = ensure_layout(tmp_path / "data")
    server = ReportHTTPServer(
        ("127.0.0.1", 0),
        Handler,
        data_dir,
        scan_registry(root / "templates"),
        load_config(data_dir),
    )
    server.port = server.server_port
    sid = "0123456789abcdef" * 2
    subscriber_id, subscriber = server.hub.subscribe(False, sid=sid)
    server.hub.mark_write(subscriber_id)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    headers = {
        "Host": f"127.0.0.1:{server.port}",
        "Origin": f"http://127.0.0.1:{server.port}",
        "X-RS-CSRF": server.csrf,
        "Content-Type": "application/json",
    }
    try:
        assert json.loads(request(server.port, "GET", "/hello")[1])["window_alive"]
        status, _ = request(
            server.port,
            "POST",
            "/bye",
            json.dumps({"sid": sid}).encode("ascii"),
            headers,
        )
        assert status == 200
        assert not json.loads(request(server.port, "GET", "/hello")[1])["window_alive"]
        assert subscriber["closed"].is_set()
        assert subscriber["queue"].get_nowait() is None
    finally:
        server.stopping.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_finding_4_bye_closes_real_sse_socket(tmp_path):
    root = Path(__file__).resolve().parents[1]
    data_dir = ensure_layout(tmp_path / "data")
    server = ReportHTTPServer(
        ("127.0.0.1", 0),
        Handler,
        data_dir,
        scan_registry(root / "templates"),
        load_config(data_dir),
    )
    server.port = server.server_port
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    sid = "0123456789abcdef" * 2
    stream = socket.create_connection(("127.0.0.1", server.port), timeout=2)
    stream.sendall(
        (
            f"GET /events?sid={sid} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{server.port}\r\n"
            "\r\n"
        ).encode("ascii")
    )
    received = b""
    try:
        while b"event: runs" not in received or not received.endswith(b"\n\n"):
            received += stream.recv(4096)
        status, _ = request(
            server.port,
            "POST",
            "/bye",
            json.dumps({"sid": sid}).encode("ascii"),
            {
                "Host": f"127.0.0.1:{server.port}",
                "Origin": f"http://127.0.0.1:{server.port}",
                "X-RS-CSRF": server.csrf,
                "Content-Type": "application/json",
            },
        )
        assert status == 200
        stream.settimeout(1)
        try:
            trailing = stream.recv(1)
        except TimeoutError:
            trailing = None
        assert trailing == b""
    finally:
        stream.close()
        server.stopping.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_push_ping_probe_drops_dead_non_test_subscriber(tmp_path):
    root = Path(__file__).resolve().parents[1]
    data_dir = ensure_layout(tmp_path / "data")
    server = ReportHTTPServer(
        ("127.0.0.1", 0),
        Handler,
        data_dir,
        scan_registry(root / "templates"),
        load_config(data_dir),
    )
    server.port = server.server_port
    writes = []

    def dead_writer(message):
        writes.append(message)
        raise BrokenPipeError()

    subscriber_id, _ = server.hub.subscribe(
        False, sid="0123456789abcdef" * 2, writer=dead_writer
    )
    server.hub.mark_write(subscriber_id)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        status, body = request(
            server.port,
            "POST",
            "/push",
            json.dumps(valid_payload()).encode("utf-8"),
            {
                "Host": f"127.0.0.1:{server.port}",
                "X-RS-Token": server.token,
                "Content-Type": "application/json",
            },
        )
        assert status == 200
        assert json.loads(body)["window_alive"] is False
        assert writes == [": ping\n\n"]
        assert not server.hub.has_subscribers()
    finally:
        server.stopping.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_finding_1_first_push_drops_sse_peer_closed_without_bye(tmp_path):
    root = Path(__file__).resolve().parents[1]
    data_dir = ensure_layout(tmp_path / "data")
    server = ReportHTTPServer(
        ("127.0.0.1", 0),
        Handler,
        data_dir,
        scan_registry(root / "templates"),
        load_config(data_dir),
    )
    server.port = server.server_port
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    stream = socket.create_connection(("127.0.0.1", server.port), timeout=2)
    stream.sendall(
        (
            "GET /events?sid=0123456789abcdef0123456789abcdef HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{server.port}\r\n"
            "\r\n"
        ).encode("ascii")
    )
    received = b""
    try:
        while b"event: runs" not in received or not received.endswith(b"\n\n"):
            received += stream.recv(4096)
        stream.shutdown(socket.SHUT_WR)
        status, body = request(
            server.port,
            "POST",
            "/push",
            json.dumps(valid_payload()).encode("utf-8"),
            {
                "Host": f"127.0.0.1:{server.port}",
                "X-RS-Token": server.token,
                "Content-Type": "application/json",
            },
        )
        assert status == 200
        assert json.loads(body)["window_alive"] is False
        assert not server.hub.has_subscribers()
    finally:
        stream.close()
        server.stopping.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_finding_2_open_probes_dead_live_and_test_sse_peers(tmp_path):
    root = Path(__file__).resolve().parents[1]
    data_dir = ensure_layout(tmp_path / "data")
    server = ReportHTTPServer(
        ("127.0.0.1", 0),
        Handler,
        data_dir,
        scan_registry(root / "templates"),
        load_config(data_dir),
    )
    server.port = server.server_port
    server.runs.register(validate_payload(valid_payload(), server.registry))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def connect_sse(sid, test=False):
        stream = socket.create_connection(
            ("127.0.0.1", server.port), timeout=2
        )
        query = f"sid={sid}" + ("&client=test" if test else "")
        stream.sendall(
            (
                f"GET /events?{query} HTTP/1.1\r\n"
                f"Host: 127.0.0.1:{server.port}\r\n"
                "\r\n"
            ).encode("ascii")
        )
        received = b""
        while b"event: runs" not in received or not received.endswith(b"\n\n"):
            received += stream.recv(4096)
        return stream

    def wait_for_no_window():
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            if server.hub.probe_window() is False:
                return
            time.sleep(.01)
        assert server.hub.probe_window() is False

    streams = []
    try:
        live = connect_sse("1" * 32)
        streams.append(live)
        with (
            patch("core.cli.launch_window") as launch,
            patch("core.cli.focus_window") as focus,
        ):
            assert command_open(data_dir, server.port) == 0
            launch.assert_not_called()
            focus.assert_called_once()

        live.shutdown(socket.SHUT_RDWR)
        live.close()
        streams.remove(live)
        wait_for_no_window()

        test_peer = connect_sse("2" * 32, test=True)
        streams.append(test_peer)
        with (
            patch("core.cli.launch_window", return_value=1234) as launch,
            patch("core.cli.focus_window") as focus,
        ):
            assert command_open(data_dir, server.port) == 0
            launch.assert_called_once()
            focus.assert_not_called()

        dead = connect_sse("3" * 32)
        streams.append(dead)
        dead.shutdown(socket.SHUT_RDWR)
        dead.close()
        streams.remove(dead)
        wait_for_no_window()
        with (
            patch("core.cli.launch_window", return_value=1234) as launch,
            patch("core.cli.focus_window") as focus,
        ):
            assert command_open(data_dir, server.port) == 0
            launch.assert_called_once()
            focus.assert_not_called()
    finally:
        for stream in streams:
            stream.close()
        server.stopping.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_page_uses_sid_for_events_and_sends_keepalive_bye():
    source = (
        Path(__file__).resolve().parents[1] / "core" / "static" / "rs.js"
    ).read_text(encoding="utf-8")
    assert "crypto.getRandomValues" in source
    assert re.search(r"/events\?sid=|set\(\s*['\"]sid['\"]", source)
    assert re.search(r"['\"]pagehide['\"]", source)
    assert re.search(r"fetch\(\s*['\"]/bye['\"]", source)
    assert re.search(r"keepalive:\s*true", source)
    assert re.search(r"JSON\.stringify\(\{\s*sid", source)


def test_body_limit_is_enforced_before_json(server_process):
    process, env, port = server_process(os.environ)
    state = json.loads((Path(env["RS_DATA_DIR"]) / "state.json").read_text())
    status, _ = request(
        port,
        "POST",
        "/push",
        b"x" * (2 * 1024 * 1024 + 1),
        {"Host": f"127.0.0.1:{port}", "X-RS-Token": state["token"]},
    )
    assert status == 413


@pytest.mark.parametrize(
    ("field", "value", "pointer"),
    [
        ("run_id", "", "/run_id"),
        ("run_id", None, "/run_id"),
        ("run_id", False, "/run_id"),
        ("created", None, "/created"),
        ("created", "9999-12-31T23:00:00+00:00", "/created"),
        ("notify", None, "/notify"),
        ("template", [], "/template"),
    ],
)
def test_push_returns_400_for_malformed_envelope_fields(
    server_process, field, value, pointer
):
    process, env, port = server_process(os.environ)
    state = json.loads((Path(env["RS_DATA_DIR"]) / "state.json").read_text())
    payload = valid_payload()
    payload[field] = value
    status, body = request(
        port,
        "POST",
        "/push",
        json.dumps(payload).encode("utf-8"),
        {"Host": f"127.0.0.1:{port}", "X-RS-Token": state["token"]},
    )
    assert status == 400
    assert json.loads(body)["pointer"] == pointer


def test_guarded_action_routes_reject_non_object_json_bodies(server_process):
    process, env, port = server_process(os.environ)
    page = request(port, "GET", "/")[1].decode("utf-8")
    marker = '<script id="rs-boot" type="application/json">'
    csrf = json.loads(page.split(marker, 1)[1].split("</script>", 1)[0])["csrf"]
    headers = {
        "Host": f"127.0.0.1:{port}",
        "Origin": f"http://127.0.0.1:{port}",
        "X-RS-CSRF": csrf,
        "Content-Type": "application/json",
    }
    for route in ("/submit", "/cancel", "/read", "/log", "/reveal", "/copy"):
        status, body = request(port, "POST", route, b"[]", headers)
        assert status == 400, route
        assert json.loads(body)["pointer"] == "/"


def test_client_log_rejects_comments_and_never_persists_them(server_process):
    process, env, port = server_process(os.environ)
    state = json.loads((Path(env["RS_DATA_DIR"]) / "state.json").read_text())
    status, body = request(
        port,
        "POST",
        "/push",
        json.dumps(valid_payload()).encode("utf-8"),
        {"Host": f"127.0.0.1:{port}", "X-RS-Token": state["token"]},
    )
    assert status == 200
    run_id = json.loads(body)["run_id"]
    page = request(port, "GET", "/")[1].decode("utf-8")
    marker = '<script id="rs-boot" type="application/json">'
    csrf = json.loads(page.split(marker, 1)[1].split("</script>", 1)[0])["csrf"]
    headers = {
        "Host": f"127.0.0.1:{port}",
        "Origin": f"http://127.0.0.1:{port}",
        "X-RS-CSRF": csrf,
        "Content-Type": "application/json",
    }
    private = "PRIVATE_COMMENT_REGRESSION"
    status, _ = request(
        port,
        "POST",
        "/log",
        json.dumps(
            {"run_id": run_id, "event": "choice", "detail": {"comment": private}}
        ).encode("utf-8"),
        headers,
    )
    assert status == 400
    assert all(
        private not in path.read_text(encoding="utf-8")
        for path in (Path(env["RS_DATA_DIR"]) / "log").glob("*.jsonl")
    )


def test_stale_browser_pid_notification_uses_title_reported_by_page(tmp_path):
    root = Path(__file__).resolve().parents[1]
    data_dir = ensure_layout(tmp_path / "data")
    server = ReportHTTPServer(
        ("127.0.0.1", 0),
        Handler,
        data_dir,
        scan_registry(root / "templates"),
        load_config(data_dir),
    )
    server.port = server.server_port
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    subscriber_id, _ = server.hub.subscribe(False)
    server.hub.mark_write(subscriber_id)
    (data_dir / "state.json").write_text(
        json.dumps({"browser_pid": 999999}), encoding="utf-8"
    )
    try:
        page = request(server.port, "GET", "/")[1].decode("utf-8")
        marker = '<script id="rs-boot" type="application/json">'
        csrf = json.loads(page.split(marker, 1)[1].split("</script>", 1)[0])["csrf"]
        action_headers = {
            "Host": f"127.0.0.1:{server.port}",
            "Origin": f"http://127.0.0.1:{server.port}",
            "X-RS-CSRF": csrf,
            "Content-Type": "application/json",
        }
        displayed_title = "Aktiver Bericht · Test Bot"
        assert request(
            server.port,
            "POST",
            "/title",
            json.dumps({"title": displayed_title}).encode("utf-8"),
            action_headers,
        )[0] == 200
        with patch("core.server.flash_window", return_value=True) as flash:
            status, _ = request(
                server.port,
                "POST",
                "/push",
                json.dumps(valid_payload()).encode("utf-8"),
                {
                    "Host": f"127.0.0.1:{server.port}",
                    "X-RS-Token": server.token,
                },
            )
        assert status == 200
        flash.assert_called_once_with(999999, displayed_title)
    finally:
        server.hub.remove(subscriber_id)
        server.stopping.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_media_rejects_traversal_unc_outside_extension_and_size(tmp_path):
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    image = root / "ok.png"
    image.write_bytes(b"png")
    assert register_media(str(image), [root]).media_id.startswith("m_")
    for value in (
        str(root / ".." / "outside" / "x.png"),
        r"\\server\share\x.png",
        str(outside / "x.png"),
    ):
        with pytest.raises(MediaError):
            register_media(value, [root])
    bad = root / "x.txt"
    bad.write_text("x")
    with pytest.raises(MediaError):
        register_media(str(bad), [root])
    huge = root / "huge.png"
    with huge.open("wb") as handle:
        handle.truncate(20 * 1024 * 1024 + 1)
    with pytest.raises(MediaError):
        register_media(str(huge), [root])


def test_media_in_matching_oneof_branch_is_allowlisted_and_replaced(tmp_path):
    root = tmp_path / "allowed"
    root.mkdir()
    image = root / "image.png"
    image.write_bytes(b"png")
    schema = {
        "oneOf": [
            {
                "type": "object",
                "properties": {"image": {"type": "string", "x-rs-media": True}},
                "required": ["image"],
                "additionalProperties": False,
            },
            {"type": "null"},
        ]
    }
    media = {}
    transformed = replace_media({"image": str(image)}, schema, [root], media)
    assert transformed["image"].startswith("m_")
    assert media[transformed["image"]].path == image.resolve()

    outside = tmp_path / "outside.png"
    outside.write_bytes(b"png")
    with pytest.raises(MediaError, match="outside configured roots"):
        replace_media({"image": str(outside)}, schema, [root], {})


@pytest.mark.skipif(os.name != "nt", reason="junctions are Windows-specific")
def test_media_rejects_junction_escape(tmp_path):
    import subprocess

    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    image = outside / "x.png"
    image.write_bytes(b"x")
    junction = root / "jump"
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(junction), str(outside)],
        capture_output=True,
    )
    if result.returncode:
        pytest.skip("junction creation unavailable")
    with pytest.raises(MediaError):
        register_media(str(junction / "x.png"), [root])


@pytest.mark.skipif(os.name != "nt", reason="junctions are Windows-specific")
def test_finding_2_media_is_revalidated_for_get_reveal_and_reload(tmp_path):
    import subprocess

    root = Path(__file__).resolve().parents[1]
    allowed = tmp_path / "allowed"
    inside = allowed / "inside"
    outside = tmp_path / "outside"
    inside.mkdir(parents=True)
    outside.mkdir()
    (inside / "image.png").write_bytes(b"ALLOWED")
    (outside / "image.png").write_bytes(b"OUTSIDE_PRIVATE")

    data_dir = ensure_layout(tmp_path / "data")
    config = load_config(data_dir)
    config["media_roots"] = [str(allowed)]
    server = ReportHTTPServer(
        ("127.0.0.1", 0),
        Handler,
        data_dir,
        scan_registry(root / "templates"),
        config,
    )
    server.port = server.server_port
    payload = validate_payload(valid_payload(), server.registry)
    detail = server.runs.register(payload)
    run_id = detail["run_id"]
    entry = register_media(str(inside / "image.png"), [allowed])
    server.runs.media[entry.media_id] = entry
    record = server.runs._runs[run_id]
    record["media"][entry.media_id] = {
        "path": str(entry.path),
        "content_type": entry.content_type,
    }
    server.runs._save(record)

    inside.rename(allowed / "original")
    created = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(inside), str(outside)],
        capture_output=True,
    )
    if created.returncode:
        server.server_close()
        pytest.skip("junction creation unavailable")

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        status, body = request(server.port, "GET", f"/media/{entry.media_id}")
        assert status == 404
        assert b"OUTSIDE_PRIVATE" not in body
        headers = {
            "Host": f"127.0.0.1:{server.port}",
            "Origin": f"http://127.0.0.1:{server.port}",
            "X-RS-CSRF": server.csrf,
            "Content-Type": "application/json",
        }
        with patch("core.server.subprocess.Popen") as popen:
            status, _ = request(
                server.port,
                "POST",
                "/reveal",
                json.dumps({"run_id": run_id, "media_id": entry.media_id}).encode(),
                headers,
            )
        assert status == 400
        popen.assert_not_called()
    finally:
        server.stopping.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    reloaded = ReportHTTPServer(
        ("127.0.0.1", 0),
        Handler,
        data_dir,
        scan_registry(root / "templates"),
        config,
    )
    try:
        assert entry.media_id not in reloaded.runs.media
        events = [
            json.loads(line)
            for path in (data_dir / "log").glob("*.jsonl")
            for line in path.read_text(encoding="utf-8").splitlines()
        ]
        assert any(
            event["event"] == "error"
            and event["detail"].get("what") == "invalid_media"
            for event in events
        )
    finally:
        reloaded.server_close()


def test_atomic_result_never_rewrites_and_crash_leaves_no_result(tmp_path):
    results = tmp_path / "results"
    envelope = {"schema": "report-shell/result@1", "run_id": "r"}
    path = write_result(results, "r", envelope)
    assert json.loads(path.read_text()) == envelope
    with pytest.raises(ResultExists):
        write_result(results, "r", envelope)
    with pytest.raises(RuntimeError):
        write_result(results, "crash", envelope, before_replace=lambda: (_ for _ in ()).throw(RuntimeError()))
    assert not (results / "crash.json").exists()


@pytest.mark.parametrize("install_existing_result", [False, True])
def test_finding_9_process_kill_never_exposes_partial_or_rewrites_result(
    tmp_path, install_existing_result
):
    results = tmp_path / "results"
    ready = tmp_path / "ready"
    child = tmp_path / "writer.py"
    root = Path(__file__).resolve().parents[1]
    child.write_text(
        "\n".join(
            [
                "import sys, time",
                "from pathlib import Path",
                f"sys.path.insert(0, {str(root)!r})",
                "from core.results import write_result",
                "def pause():",
                f"    Path({str(ready)!r}).write_text('ready', encoding='utf-8')",
                "    time.sleep(60)",
                f"write_result({str(results)!r}, 'killed', "
                "{'schema':'report-shell/result@1','status':'submitted'}, "
                "before_replace=pause)",
            ]
        ),
        encoding="utf-8",
    )
    process = subprocess.Popen([sys.executable, str(child)])
    expected = b'{"schema":"report-shell/result@1","status":"cancelled"}\n'
    try:
        deadline = time.monotonic() + 5
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert ready.exists(), "child did not reach the pre-replace synchronization point"
        if install_existing_result:
            target = results / "killed.json"
            target.write_bytes(expected)
        process.kill()
        process.wait(timeout=3)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=3)

    target = results / "killed.json"
    if install_existing_result:
        assert target.read_bytes() == expected
    elif target.exists():
        assert json.loads(target.read_text(encoding="utf-8")) == {
            "schema": "report-shell/result@1",
            "status": "submitted",
        }
    else:
        assert not target.exists()


def test_finding_8_result_writer_rejects_non_json_numbers(tmp_path):
    results = tmp_path / "results"
    with pytest.raises(ValueError):
        write_result(results, "nan", {"value": float("nan")})
    assert not (results / "nan.json").exists()


def test_finding_8_http_rejects_non_finite_numbers_and_emits_strict_json(
    tmp_path
):
    target = install_minimal_template(tmp_path)
    number_schema = {
        "type": "object",
        "properties": {
            "value": {"type": "number", "minimum": 0, "maximum": 10}
        },
        "required": ["value"],
        "additionalProperties": False,
    }
    for name in ("schema.json", "result.schema.json"):
        (target / name).write_text(json.dumps(number_schema), encoding="utf-8")
    values = {
        "golden.json": {"value": 0},
        "edge-max.json": {"value": 10},
        "edge-unicode.json": {"value": 5},
        "invalid-empty.json": {"value": -1},
        "invalid-type.json": {"value": 11},
    }
    for old in (target / "fixtures").glob("*.json"):
        old.unlink()
    for name, value in values.items():
        (target / "fixtures" / name).write_text(
            json.dumps(value), encoding="utf-8"
        )

    data_dir = ensure_layout(tmp_path / "data")
    server = ReportHTTPServer(
        ("127.0.0.1", 0),
        Handler,
        data_dir,
        scan_registry(tmp_path / "templates"),
        load_config(data_dir),
    )
    server.port = server.server_port
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def strict_loads(raw):
        def reject(value):
            raise ValueError(f"non-JSON constant {value}")

        def finite_float(value):
            parsed = float(value)
            if parsed == float("inf") or parsed == float("-inf"):
                raise ValueError("non-finite number")
            return parsed

        return json.loads(
            raw, parse_constant=reject, parse_float=finite_float
        )

    headers = {
        "Host": f"127.0.0.1:{server.port}",
        "X-RS-Token": server.token,
        "Content-Type": "application/json",
    }
    payload = valid_payload()
    payload["data"] = {"value": float("nan")}
    try:
        for numeric_source in ("NaN", "1e999"):
            raw = json.dumps(payload).replace("NaN", numeric_source).encode()
            status, body = request(server.port, "POST", "/push", raw, headers)
            assert status == 400
            assert strict_loads(body)["error"] == "invalid_json"

        payload["data"] = {"value": 10}
        status, body = request(
            server.port,
            "POST",
            "/push",
            json.dumps(payload).encode(),
            headers,
        )
        assert status == 200
        pushed = strict_loads(body)
        run_id = pushed["run_id"]
        status, body = request(
            server.port,
            "GET",
            f"/api/run/{run_id}",
            headers={
                "Host": f"127.0.0.1:{server.port}",
                "X-RS-CSRF": server.csrf,
            },
        )
        assert status == 200
        assert strict_loads(body)["data"]["value"] == 10
        status, body = request(
            server.port,
            "POST",
            "/submit",
            json.dumps({"run_id": run_id, "data": {"value": 0}}).encode(),
            {
                "Host": f"127.0.0.1:{server.port}",
                "Origin": f"http://127.0.0.1:{server.port}",
                "X-RS-CSRF": server.csrf,
                "Content-Type": "application/json",
            },
        )
        assert status == 200
        strict_loads(body)
        strict_loads(
            (data_dir / "results" / f"{run_id}.json").read_bytes()
        )
    finally:
        server.stopping.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_finding_1_killed_writer_recovers_orphan_and_maintenance_continues(
    tmp_path
):
    root = Path(__file__).resolve().parents[1]
    data_dir = ensure_layout(tmp_path / "data")
    registry = scan_registry(root / "templates")
    config = load_config(data_dir)
    run_id = "20261008-120000-recovery-abcd"
    store = RunStore(data_dir, registry, config, ActionLog(data_dir))
    first = valid_payload()
    first.update(
        {
            "run_id": run_id,
            "created": "2026-10-08T00:00:00+02:00",
            "expires_minutes": 5,
        }
    )
    store.register(validate_payload(first, registry))

    ready = tmp_path / "writer-ready"
    child = tmp_path / "writer.py"
    child.write_text(
        "\n".join(
            [
                "import sys, time",
                "from pathlib import Path",
                f"sys.path.insert(0, {str(root)!r})",
                "from core.results import write_result",
                "def pause():",
                f"    Path({str(ready)!r}).write_text('ready', encoding='utf-8')",
                "    time.sleep(60)",
                f"write_result({str(data_dir / 'results')!r}, {run_id!r}, "
                "{'schema':'report-shell/result@1','status':'submitted'}, "
                "before_replace=pause)",
            ]
        ),
        encoding="utf-8",
    )
    process = subprocess.Popen([sys.executable, str(child)])
    try:
        deadline = time.monotonic() + 5
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert ready.exists()
        process.kill()
        process.wait(timeout=3)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=3)
    assert (data_dir / "results" / f"{run_id}.json.tmp").is_file()

    server = ReportHTTPServer(
        ("127.0.0.1", 0), Handler, data_dir, registry, config
    )
    maintenance = threading.Thread(
        target=server_module._maintenance, args=(server,), daemon=True
    )
    with patch(
        "core.runs.vienna_now",
        return_value=to_vienna("2026-10-08T14:00:00+02:00"),
    ):
        maintenance.start()
        first_result = data_dir / "results" / f"{run_id}.json"
        deadline = time.monotonic() + 4
        while not first_result.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert first_result.is_file()
        assert not (data_dir / "results" / f"{run_id}.json.tmp").exists()
        assert maintenance.is_alive()

        later = valid_payload()
        later.update(
            {
                "run_id": "20261008-120100-later-abcd",
                "created": "2026-10-08T12:01:00+02:00",
                "expires_minutes": 5,
            }
        )
        server.runs.register(validate_payload(later, registry))
        later_result = data_dir / "results" / "20261008-120100-later-abcd.json"
        deadline = time.monotonic() + 3
        while not later_result.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert later_result.is_file()
        assert maintenance.is_alive()
    server.stopping.set()
    maintenance.join(timeout=2)
    server.server_close()


def test_finding_1_expiry_failure_is_sanitized_and_does_not_skip_later_run(
    tmp_path
):
    root = Path(__file__).resolve().parents[1]
    data_dir = ensure_layout(tmp_path / "data")
    registry = scan_registry(root / "templates")
    action_log = ActionLog(data_dir)
    store = RunStore(data_dir, registry, load_config(data_dir), action_log)
    failed_id = "20261008-120000-failed-abcd"
    later_id = "20261008-120001-later-abcd"
    for run_id in (failed_id, later_id):
        payload = valid_payload()
        payload.update(
            {
                "run_id": run_id,
                "created": "2026-10-08T00:00:00+02:00",
                "expires_minutes": 5,
            }
        )
        store.register(validate_payload(payload, registry))
    original_decide = store.decide

    def fail_one(run_id, status, data=None):
        if run_id == failed_id:
            raise OSError(r"C:\private\payload-path")
        return original_decide(run_id, status, data)

    with (
        patch.object(store, "decide", side_effect=fail_one),
        patch(
            "core.runs.vienna_now",
            return_value=to_vienna("2026-10-08T14:00:00+02:00"),
        ),
    ):
        assert store.expire_due() == [later_id]
    events = [
        json.loads(line)
        for path in (data_dir / "log").glob("*.jsonl")
        for line in path.read_text(encoding="utf-8").splitlines()
    ]
    failure = next(
        event
        for event in events
        if event["event"] == "error"
        and event["detail"].get("what") == "expire_failed"
    )
    assert failure["run_id"] == failed_id
    assert failure["detail"] == {
        "what": "expire_failed",
        "error": "OSError",
    }
    assert "private" not in json.dumps(failure)


def test_finding_2_surrogate_routes_reject_before_state_change_and_server_survives(
    server_process
):
    process, env, port = server_process(os.environ)
    state = json.loads((Path(env["RS_DATA_DIR"]) / "state.json").read_text())
    push_headers = {
        "Host": f"127.0.0.1:{port}",
        "X-RS-Token": state["token"],
        "Content-Type": "application/json",
    }
    status, body = request(
        port,
        "POST",
        "/push",
        json.dumps(valid_payload()).encode("utf-8"),
        push_headers,
    )
    assert status == 200
    run_id = json.loads(body)["run_id"]
    page = request(port, "GET", "/")[1].decode("utf-8")
    marker = '<script id="rs-boot" type="application/json">'
    csrf = json.loads(page.split(marker, 1)[1].split("</script>", 1)[0])["csrf"]
    action_headers = {
        "Host": f"127.0.0.1:{port}",
        "Origin": f"http://127.0.0.1:{port}",
        "X-RS-CSRF": csrf,
        "Content-Type": "application/json",
    }
    poisoned_push = valid_payload()
    poisoned_push["title"] = "\ud800"
    cases = [
        (
            "/title",
            b'{"title":"\\ud800"}',
            action_headers,
            "/title",
        ),
        (
            "/log",
            json.dumps(
                {
                    "run_id": run_id,
                    "event": "choice",
                    "detail": {"item": "\ud800"},
                }
            ).encode("ascii"),
            action_headers,
            "/detail/item",
        ),
        (
            "/submit",
            (
                '{"run_id":'
                + json.dumps(run_id)
                + ',"data":{"\\ud800":true}}'
            ).encode("ascii"),
            action_headers,
            "/data/\\ud800",
        ),
        (
            "/push",
            json.dumps(poisoned_push).encode("ascii"),
            push_headers,
            "/title",
        ),
    ]
    for route, raw, headers, pointer in cases:
        status, body = request(port, "POST", route, raw, headers)
        assert status == 400, route
        assert json.loads(body)["pointer"] == pointer

    status, _ = request(
        port,
        "POST",
        "/title",
        b'{"title":"\\ud83d\\ude00 Bericht"}',
        action_headers,
    )
    assert status == 200
    status, body = request(port, "GET", "/hello")
    hello = json.loads(body)
    assert status == 200
    assert hello["window_title"] == "😀 Bericht"
    assert hello["open_runs"] == 1

    command_env = dict(os.environ, RS_DATA_DIR=env["RS_DATA_DIR"])
    fixture = (
        Path(__file__).resolve().parents[1]
        / "templates"
        / "global"
        / "_starter"
        / "fixtures"
        / "golden.json"
    )
    shown = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve().parents[1] / "report_shell.py"),
            "--port",
            str(port),
            "show",
            "_starter",
            "--data",
            str(fixture),
            "--no-window",
        ],
        env=command_env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert shown.returncode == 0, shown.stderr
    stopped = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve().parents[1] / "report_shell.py"),
            "--port",
            str(port),
            "stop",
        ],
        env=command_env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert stopped.returncode == 0
    assert json.loads(stopped.stdout)["stopped"] is True


def test_finding_5_deep_http_bodies_return_400_with_pointer_and_keep_running(
    server_process
):
    process, env, port = server_process(os.environ)
    state = json.loads((Path(env["RS_DATA_DIR"]) / "state.json").read_text())
    page = request(port, "GET", "/")[1].decode("utf-8")
    marker = '<script id="rs-boot" type="application/json">'
    csrf = json.loads(page.split(marker, 1)[1].split("</script>", 1)[0])["csrf"]
    deep = b"[" * 1100 + b"0" + b"]" * 1100
    for route, headers in [
        (
            "/push",
            {
                "Host": f"127.0.0.1:{port}",
                "X-RS-Token": state["token"],
                "Content-Type": "application/json",
            },
        ),
        (
            "/submit",
            {
                "Host": f"127.0.0.1:{port}",
                "Origin": f"http://127.0.0.1:{port}",
                "X-RS-CSRF": csrf,
                "Content-Type": "application/json",
            },
        ),
    ]:
        status, body = request(port, "POST", route, deep, headers)
        assert status == 400
        assert json.loads(body)["pointer"] == "/0" * 64
    status, body = request(port, "GET", "/hello")
    assert status == 200
    assert json.loads(body)["open_runs"] == 0


def test_finding_3_max_depth_run_reloads_for_detail_submit_and_expiry(
    tmp_path
):
    target = install_minimal_template(tmp_path)
    schema_path = target / "schema.json"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    schema["additionalProperties"] = True
    schema_path.write_text(json.dumps(schema), encoding="utf-8")

    data_dir = ensure_layout(tmp_path / "data")
    registry = scan_registry(tmp_path / "templates")
    config = load_config(data_dir)
    server = ReportHTTPServer(
        ("127.0.0.1", 0), Handler, data_dir, registry, config
    )
    server.port = server.server_port
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    nested = 0
    for _ in range(62):
        nested = [nested]
    run_ids = (
        "20261008-120000-depth-submit-abcd",
        "20261008-120001-depth-expire-abcd",
    )
    try:
        for run_id in run_ids:
            payload = valid_payload()
            payload.update(
                {
                    "run_id": run_id,
                    "created": "2026-10-08T00:00:00+02:00",
                    "expires_minutes": 5,
                    "data": {"message": "Hello", "nested": nested},
                }
            )
            status, _ = request(
                server.port,
                "POST",
                "/push",
                json.dumps(payload).encode("utf-8"),
                {
                    "Host": f"127.0.0.1:{server.port}",
                    "X-RS-Token": server.token,
                    "Content-Type": "application/json",
                },
            )
            assert status == 200
    finally:
        server.stopping.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    reloaded = RunStore(data_dir, registry, config, ActionLog(data_dir))
    assert reloaded.detail(run_ids[0])["data"]["nested"] == nested
    submitted = reloaded.decide(
        run_ids[0], "submitted", {"acknowledged": True}
    )
    assert json.loads(submitted.read_text(encoding="utf-8"))["status"] == "submitted"
    with patch(
        "core.runs.vienna_now",
        return_value=to_vienna("2026-10-08T14:00:00+02:00"),
    ):
        assert reloaded.expire_due() == [run_ids[1]]
    expired = data_dir / "results" / f"{run_ids[1]}.json"
    assert json.loads(expired.read_text(encoding="utf-8"))["status"] == "expired"


@pytest.mark.parametrize("content", ['{"payload":', "[]"])
def test_finding_3_unloadable_run_record_logs_error(tmp_path, content):
    root = Path(__file__).resolve().parents[1]
    data_dir = ensure_layout(tmp_path / "data")
    broken_id = "20261008-120000-broken-abcd"
    (data_dir / "runs" / f"{broken_id}.json").write_text(
        content, encoding="utf-8"
    )
    RunStore(
        data_dir,
        scan_registry(root / "templates"),
        load_config(data_dir),
        ActionLog(data_dir),
    )
    events = [
        json.loads(line)
        for path in (data_dir / "log").glob("*.jsonl")
        for line in path.read_text(encoding="utf-8").splitlines()
    ]
    assert any(
        event["run_id"] == broken_id
        and event["event"] == "error"
        and event["detail"].get("what") == "run_load_failed"
        for event in events
    )


def test_webhook_requires_config_env_and_allowlist(monkeypatch):
    config = {"webhook": {"enabled": True, "allow_prefixes": ["https://hooks.example/allowed/"]}}
    monkeypatch.delenv("GROKBOT_DESK_WEBHOOK_KEY", raising=False)
    monkeypatch.delenv("SPQRK_REPORT_SHELL_WEBHOOK_KEY", raising=False)
    assert not webhook_enabled(config)
    monkeypatch.setenv("SPQRK_REPORT_SHELL_WEBHOOK_KEY", "secret")
    assert webhook_enabled(config)
    monkeypatch.delenv("SPQRK_REPORT_SHELL_WEBHOOK_KEY")
    monkeypatch.setenv("GROKBOT_DESK_WEBHOOK_KEY", "new-secret")
    assert webhook_enabled(config)
    validate_webhook_url("https://hooks.example/allowed/42", config)
    with pytest.raises(ValueError):
        validate_webhook_url("https://evil.example/", config)
    with pytest.raises(ValueError, match="HTTPS"):
        validate_webhook_url("http://hooks.example/allowed/42", {
            "webhook": {"allow_prefixes": ["http://hooks.example/allowed/"]}
        })
    assert "secret" not in json.dumps(config)


def test_webhook_redirect_rejects_disallowed_destination_before_forwarding_key():
    config = {"webhook": {"allow_prefixes": ["https://hooks.example/allowed/"]}}
    request_with_key = urllib.request.Request(
        "https://hooks.example/allowed/1",
        data=b"{}",
        headers={"Authorization": "Bearer fake-key"},
        method="POST",
    )
    handler = webhook.WebhookRedirectHandler(config)
    with pytest.raises(ValueError, match="allowlisted"):
        handler.redirect_request(
            request_with_key,
            None,
            302,
            "Found",
            {"Location": "https://evil.example/sink"},
            "https://evil.example/sink",
        )
    with pytest.raises(ValueError, match="HTTPS"):
        handler.redirect_request(
            request_with_key,
            None,
            307,
            "Temporary Redirect",
            {"Location": "http://hooks.example/allowed/sink"},
            "http://hooks.example/allowed/sink",
        )


def test_webhook_non_success_response_logs_failure(monkeypatch, tmp_path):
    config = {"webhook": {"enabled": True, "allow_prefixes": ["https://hooks.example/"]}}
    monkeypatch.setenv("GROKBOT_DESK_WEBHOOK_KEY", "secret")
    monkeypatch.delenv("SPQRK_REPORT_SHELL_WEBHOOK_KEY", raising=False)
    events = []
    requests = []
    action_log = type("Log", (), {"write": lambda self, run_id, event, detail: events.append(event)})()
    response = type(
        "Response",
        (),
        {
            "status": 500,
            "__enter__": lambda self: self,
            "__exit__": lambda self, *args: None,
        },
    )()
    assert not deliver(
        "https://hooks.example/42",
        {"run_id": "r"},
        config,
        "r",
        action_log,
        opener=lambda request, **kwargs: requests.append(request) or response,
        sleeper=lambda seconds: None,
    )
    assert events == ["webhook_fail"]
    assert requests[0].get_header("User-agent") == "grokbot-desk/1"
