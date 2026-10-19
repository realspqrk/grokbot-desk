"""Opening a link: allowlist, scheme checks, and the OS browser openers."""
import http.client
import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from core.browse import open_url as browse_open_url
from core.envelope import validate_payload
from core.paths import ensure_layout, load_config
from core.platform_darwin import open_url as darwin_open_url
from core.platform_windows import open_url as windows_open_url
from core.server import Handler, ReportHTTPServer
from core.urls import MAX_URL_LENGTH, openable, url_allowed, urls_in


ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = "https://example.com/posts/1"
LONGER = "https://example.com/posts/1/reply"


def test_openable_accepts_http_and_https_only():
    assert openable(EXAMPLE)
    assert openable("http://example.com/a")
    assert openable("HTTPS://example.com/a")
    for bad in (
        "",
        "javascript:alert(1)",
        "data:text/html,hi",
        "file:///etc/passwd",
        "https://user:secret@example.com/a",
        "https://user@example.com/a",
        "https:///missing-host",
        "https://example.com/a path",
        "example.com",
        "//example.com/a",
        "https://example.com\\@evil.example",
        "http://" + "a" * 2048,
    ):
        assert openable(bad) is False, bad
    host = "https://example.com/"
    assert openable(host + "a" * (MAX_URL_LENGTH - len(host)))
    assert openable(host + "a" * (MAX_URL_LENGTH - len(host) + 1)) is False
    for good in (
        "https://example.com/a@b",
        "https://example.com/a?x=@",
        "https://example.com/a?x=@#f@",
        "https://example.com:443/a",
        "https://example.com:0/a",
        "https://example.com:65535/a",
        "http://127.0.0.1:8080/a",
        "https://[::1]/a",
    ):
        assert openable(good), good
    for bad in (
        "https://example.com:abc",
        "https://example.com:99999",
        "https://example.com:/a",
        "https://[oops",
        "https://example.com/\x00a",
        "https://example.com/a\x7f",
        "https://example.com/a\u0085",
        "https://example.com/a\u009f",
    ):
        assert openable(bad) is False, bad


def test_malformed_neighbor_does_not_drop_a_valid_url():
    data = {
        "url": EXAMPLE,
        "note": "broken https://[oops and a note",
        "nul": "prefix https://example.com/\x00hidden",
        "port": "see https://example.com:99999/nope",
    }
    found = urls_in(data)
    assert EXAMPLE in found
    assert url_allowed(EXAMPLE, data)
    assert url_allowed("https://[oops", data) is False
    assert url_allowed("https://example.com/\x00hidden", data) is False
    assert url_allowed("https://example.com:99999/nope", data) is False


def test_allowlist_is_verbatim_and_extracts_urls_from_text():
    data = {
        "url": EXAMPLE,
        "detail": f"Reply under {LONGER}.",
        "note": "See https://example.com/help), then stop.",
        "secret": "https://user:secret@example.com/hidden",
        "nested": [{"text": "Also <https://example.com/angle>"}],
    }
    found = urls_in(data)
    assert EXAMPLE in found
    assert LONGER in found
    assert "https://example.com/help" in found
    assert "https://example.com/angle" in found
    assert "https://user:secret@example.com/hidden" not in found
    assert url_allowed(EXAMPLE, data)
    assert url_allowed(LONGER, data)
    assert url_allowed("https://example.com/posts/1/reply.", data) is False
    assert url_allowed("https://example.com", data) is False
    assert url_allowed("https://evil.example/posts/1", data) is False
    assert url_allowed("https://user:secret@example.com/hidden", data) is False
    assert url_allowed(EXAMPLE + "\nhttps://evil.example", data) is False


def test_windows_opener_uses_startfile():
    # os.startfile exists only on Windows; create it for the other runners
    with patch("core.platform_windows.os.startfile", create=True) as startfile:
        windows_open_url(EXAMPLE)
    startfile.assert_called_once_with(EXAMPLE)


def test_darwin_opener_uses_open_without_a_shell():
    with patch("core.platform_darwin.subprocess.Popen") as popen:
        darwin_open_url(EXAMPLE)
    popen.assert_called_once_with(["/usr/bin/open", EXAMPLE], shell=False)


def test_linux_opener_uses_xdg_open_when_present():
    with patch("core.browse.sys.platform", "linux"), \
            patch("core.browse.shutil.which", return_value="/usr/bin/xdg-open"), \
            patch("core.browse.subprocess.Popen") as popen:
        browse_open_url(EXAMPLE)
    popen.assert_called_once_with(["/usr/bin/xdg-open", EXAMPLE], shell=False)


def test_linux_opener_fails_when_xdg_open_is_missing():
    with patch("core.browse.sys.platform", "linux"), \
            patch("core.browse.shutil.which", return_value=None):
        try:
            browse_open_url(EXAMPLE)
        except OSError as error:
            assert "xdg-open" in str(error)
        else:
            raise AssertionError("expected OSError")


def _server(tmp_path):
    data_dir = ensure_layout(tmp_path / "data")
    server = ReportHTTPServer(
        ("127.0.0.1", 0), Handler, data_dir,
        load_config(data_dir),
    )
    server.port = server.server_port
    return server


def _request(server, body):
    connection = http.client.HTTPConnection("127.0.0.1", server.port, timeout=15)  # socket timeout, not a budget
    headers = {
        "Host": f"127.0.0.1:{server.port}",
        "Origin": f"http://127.0.0.1:{server.port}",
        "X-RS-CSRF": server.csrf,
        "Content-Type": "application/json",
    }
    connection.request("POST", "/open-url", body=json.dumps(body).encode(), headers=headers)
    response = connection.getresponse()
    payload = response.read()
    connection.close()
    return response.status, payload


def test_open_url_route_allowlists_and_logs(tmp_path):
    server = _server(tmp_path)
    payload = {
        "schema": "grokbot-desk/payload@2",
        "bot": "listing-bot",
        "title": "Open a documented link",
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "ask": "review",
        "blocks": [{
            "type": "text",
            "md": f"See the [listing]({EXAMPLE}) before you approve. Ignore https://[oops nearby.",
        }],
    }
    detail = server.runs.register(validate_payload(payload))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with patch("core.server.open_url") as opener:
            status, body = _request(server, {"run_id": detail["run_id"], "url": EXAMPLE})
            assert status == 200, body
            opener.assert_called_once_with(EXAMPLE)
            status, body = _request(server, {"run_id": detail["run_id"], "url": "https://evil.example"})
            assert status == 400
            assert json.loads(body)["error"] == "invalid_url"
            status, _ = _request(server, {"run_id": "missing", "url": EXAMPLE})
            assert status == 404
            opener.assert_called_once()
        with patch("core.server.open_url") as opener:
            status, body = _request(server, {"run_id": detail["run_id"], "url": "https://[oops"})
            assert status == 400
            assert json.loads(body)["error"] == "invalid_url"
            status, body = _request(server, {"run_id": detail["run_id"], "url": "https://example.com/\x00"})
            assert status == 400
            assert json.loads(body)["error"] == "invalid_url"
            opener.assert_not_called()
        with patch("core.server.open_url", side_effect=ValueError("unusable")) as opener:
            status, body = _request(server, {"run_id": detail["run_id"], "url": EXAMPLE})
            assert status == 500, body
            assert json.loads(body) == {"error": "open_failed"}
            opener.assert_called_once_with(EXAMPLE)
        log = list((server.data_dir / "log").glob("*.jsonl"))
        assert log
        events = [json.loads(line) for line in log[0].read_text(encoding="utf-8").splitlines()]
        assert any(event["event"] == "open_url" and event["detail"]["url"] == EXAMPLE for event in events)
    finally:
        server.stopping.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
