"""P8d pop-up layout: window default, strings and shell structure."""
import json
import re
from html.parser import HTMLParser
from pathlib import Path

from core import paths, platform_darwin, platform_types

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "core" / "static"


def test_default_window_is_the_compact_popup(tmp_path):
    window = paths.default_config(tmp_path)["window"]
    assert (window["width"], window["height"]) == (880, 920)
    assert (platform_types.DEFAULT_WINDOW_WIDTH, platform_types.DEFAULT_WINDOW_HEIGHT) == (880, 920)
    # a config.json window still wins, field by field
    (tmp_path / "config.json").write_text(json.dumps({"window": {"width": 1500}}), encoding="utf-8")
    loaded = paths.load_config(tmp_path)["window"]
    assert (loaded["width"], loaded["height"]) == (1500, 920)
    # macOS falls back to the same default for missing or invalid sizes
    assert platform_darwin._geometry({"window": {"width": "x", "height": -1}})[2:] == (880, 920)


def test_strip_and_done_strings_in_both_tables():
    keys = {
        "strip_label": set(),
        "strip_count": {"n", "m"},
        "strip_count_all": {"m"},
        "strip_item": {"bot", "title"},
        "done_title": set(),
        "done_closing": set(),
        "done_keep_open": set(),
    }
    tables = {lang: json.loads((ROOT / "core" / "i18n" / f"{lang}.json").read_text(encoding="utf-8")) for lang in ("de", "en")}
    for lang, table in tables.items():
        for key, params in keys.items():
            assert table.get(key), (lang, key)
            assert set(re.findall(r"\{([a-z_]+)\}", table[key])) == params, (lang, key)
        assert not [k for k in table if k.startswith("rail_")], lang
    assert tables["en"]["strip_count"] == "{n} of {m} open"
    assert tables["de"]["strip_count"] == "{n} von {m} offen"


class _Tree(HTMLParser):
    def __init__(self):
        super().__init__()
        self.order = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        self.order.append((tag, a.get("id"), a.get("class") or "", a))


def test_shell_strip_sits_above_the_header_and_the_title_is_the_quiet_line():
    tree = _Tree()
    tree.feed((STATIC / "shell.html").read_text(encoding="utf-8"))
    ids = [item[1] for item in tree.order if item[1]]
    assert "rs-rail" not in ids and "rs-rail-nav" not in ids
    assert ids.index("rs-strip-nav") < ids.index("rs-bot") < ids.index("rs-more-btn") < ids.index("rs-mount")
    nav = next(item for item in tree.order if item[1] == "rs-strip-nav")
    assert nav[0] == "nav" and "hidden" in nav[3]
    toolbar = next(item for item in tree.order if item[1] == "rs-strip")
    assert toolbar[3].get("role") == "toolbar"
    # header: avatar, then the name over the h1 report title
    assert ids.index("rs-bot-avatar") < ids.index("rs-bot-name") < ids.index("rs-title")
    title = next(item for item in tree.order if item[1] == "rs-title")
    assert title[0] == "h1"


def test_shell_css_has_no_rail_and_paints_the_strip_in_ink():
    css = (STATIC / "shell.css").read_text(encoding="utf-8")
    assert "rs-rail" not in css and "--rs-rail-w" not in css
    underline = re.search(r"\.rs-strip__run\[aria-current\]::after\s*\{([^}]*)\}", css).group(1)
    assert "var(--rs-ink)" in underline and "accent" not in underline
    strip = "".join(re.findall(r"\.rs-strip[^{]*\{([^}]*)\}", css))
    assert "accent" not in strip
    assert "transition" not in strip and "animation" not in strip


# ------------------------------------------------ app-window ownership --
# P8d fix1: only the window the server launched with --app may close itself.
# The launch URL carries the launch generation as a one-time `app` token; the
# page presents it on /events and the server answers `event: window`
# {"app": true} only while that launch is pending. Ordinary tabs (no token,
# a wrong one, or one presented after the launch was claimed) never get it.

def _serve(tmp_path):
    import threading

    from core.paths import ensure_layout, load_config
    from core.registry import scan_registry
    from core.server import Handler, ReportHTTPServer

    data_dir = ensure_layout(tmp_path / "data")
    server = ReportHTTPServer(
        ("127.0.0.1", _free_port()), Handler, data_dir,
        scan_registry(ROOT / "templates"), load_config(data_dir),
    )
    server.port = server.server_port
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, data_dir


def _free_port():
    from conftest import free_port

    return free_port()


def _initial_events(port, query):
    stream, received = _open_events(port, query)
    stream.close()
    return received


def _open_events(port, query):
    """An /events stream left open (a live page) and its initial answer."""
    import socket

    stream = socket.create_connection(("127.0.0.1", port), timeout=3)
    stream.sendall(f"GET /events?{query} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n".encode("ascii"))
    received = b""
    try:
        while b"event: runs" not in received or not received.endswith(b"\n\n"):
            chunk = stream.recv(4096)
            if not chunk:
                break
            received += chunk
    except BaseException:
        stream.close()
        raise
    return stream, received.decode("utf-8")


def test_launch_url_carries_the_one_time_app_token(tmp_path, monkeypatch):
    from core import cli as cli_module
    from core.launch_coordination import pending_launch_generation
    from core.platform_types import LaunchResult

    base = tmp_path / "data"
    base.mkdir()
    urls = []
    probed = []
    monkeypatch.setattr(cli_module, "launch_window", lambda url, *rest: urls.append(url) or LaunchResult("app"))
    # P8d fix2: the readiness probe is stubbed too; the URLs name a port
    # nothing here owns, so no real server is ever asked
    monkeypatch.setattr(cli_module, "_hello", lambda port, *rest, **kw: probed.append(port))
    cli_module._launch_window_once(base, "http://127.0.0.1:18981/?launch=r1&run=r1", {})
    generation = pending_launch_generation(base)
    assert re.fullmatch(r"[0-9a-f]{32}", generation)
    assert urls == [f"http://127.0.0.1:18981/?launch=r1&run=r1&app={generation}"]
    (base / "browser-launch.pending").unlink()
    cli_module._launch_window_once(base, "http://127.0.0.1:18981/", {})
    assert urls[1] == f"http://127.0.0.1:18981/?app={pending_launch_generation(base)}"
    assert probed == [18981, 18981]


def test_only_the_launched_window_is_told_it_owns_the_app_window(tmp_path, monkeypatch):
    from core import cli as cli_module
    from core.launch_coordination import pending_launch_generation
    from core.platform_types import LaunchResult

    server, data_dir = _serve(tmp_path)
    monkeypatch.setattr(cli_module, "launch_window", lambda *args: LaunchResult("app"))
    try:
        cli_module._launch_window_once(data_dir, f"http://127.0.0.1:{server.port}/", {})
        token = pending_launch_generation(data_dir)
        sid = "0123456789abcdef" * 2
        # an ordinary tab: no token, or a wrong one
        assert "event: window" not in _initial_events(server.port, f"sid={'1' * 32}")
        assert "event: window" not in _initial_events(server.port, f"sid={'2' * 32}&app={'f' * 32}")
        # the ordinary tabs above claimed the pending launch: re-arm it
        cli_module._clear_launch_pending(data_dir, pending_launch_generation(data_dir))
        cli_module._launch_window_once(data_dir, f"http://127.0.0.1:{server.port}/", {})
        token = pending_launch_generation(data_dir)
        owned = _initial_events(server.port, f"sid={sid}&app={token}")
        assert 'event: window\ndata: {"app":true}\n\n' in owned
        assert owned.index("event: window") < owned.index("event: runs")
        # the same page reconnecting keeps it; another page with the token does not
        assert "event: window" in _initial_events(server.port, f"sid={sid}&app={token}")
        assert "event: window" not in _initial_events(server.port, f"sid={'3' * 32}&app={token}")
        # a test client never owns the app window
        assert "event: window" not in _initial_events(server.port, f"sid={'4' * 32}&app={token}&client=test")
    finally:
        server.stopping.set()
        server.shutdown()


def test_a_launch_token_is_claimed_by_exactly_one_page(tmp_path):
    # P8d fix2: the pending launch stays readable until the first stream has
    # written its answer, so pages racing with the same token all saw it;
    # the claim binds the launch to one sid atomically before answering
    import secrets
    import threading

    from core.launch_coordination import (
        acquire_launch_lock,
        mark_launch_pending,
        release_launch_lock,
    )

    server, data_dir = _serve(tmp_path)
    try:
        for _ in range(5):
            token = mark_launch_pending(data_dir)
            sids = [secrets.token_hex(16) for _ in range(20)]
            answers = {}
            gate = threading.Barrier(len(sids))

            def claim(sid):
                gate.wait()
                answers[sid] = _initial_events(server.port, f"sid={sid}&app={token}")

            threads = [threading.Thread(target=claim, args=(sid,)) for sid in sids]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(10)
            assert len(answers) == len(sids)
            owners = [sid for sid, text in answers.items() if "event: window" in text]
            assert len(owners) == 1, owners
            # the owner reconnecting keeps it; a racer retrying does not
            assert "event: window" in _initial_events(server.port, f"sid={owners[0]}&app={token}")
            loser = next(sid for sid in sids if sid != owners[0])
            assert "event: window" not in _initial_events(server.port, f"sid={loser}&app={token}")
        # while the CLI still holds its launch lock the pending launch cannot
        # be cleared, yet a second page with the token is still refused
        token = mark_launch_pending(data_dir)
        descriptor = acquire_launch_lock(data_dir)
        assert descriptor is not None
        try:
            assert "event: window" in _initial_events(server.port, f"sid={'5' * 32}&app={token}")
            assert "event: window" not in _initial_events(server.port, f"sid={'6' * 32}&app={token}")
        finally:
            release_launch_lock(data_dir, descriptor)
    finally:
        server.stopping.set()
        server.shutdown()


def test_a_reload_takes_over_the_app_window_only_from_a_page_that_is_gone(tmp_path):
    # P8d fix2: a tab the app window opens inherits its sessionStorage, so a
    # stored flag made that ordinary tab close itself. The app window keeps
    # its launch token and its current sid for itself (window.name, which a
    # new tab does not inherit); a new page in that window (a reload) names
    # the sid it replaces (`prev`) and takes over only once that page's
    # stream is gone. A live owner is never displaced.
    from core.launch_coordination import mark_launch_pending

    server, data_dir = _serve(tmp_path)
    first, second, third = "a" * 32, "b" * 32, "c" * 32
    try:
        token = mark_launch_pending(data_dir)
        stream, owned = _open_events(server.port, f"sid={first}&app={token}")
        try:
            assert "event: window" in owned
            # a copy of the page (token and owner sid) while the owner lives
            assert "event: window" not in _initial_events(server.port, f"sid={second}&app={token}&prev={first}")
        finally:
            stream.close()
        # the owner's page is gone (reload): its successor takes over
        assert "event: window" in _initial_events(server.port, f"sid={second}&app={token}&prev={first}")
        # the replaced page, and a stale copy naming it, are refused
        assert "event: window" not in _initial_events(server.port, f"sid={first}&app={token}")
        assert "event: window" not in _initial_events(server.port, f"sid={third}&app={token}&prev={first}")
        # naming the owner needs the launch's token, and a well-formed sid
        assert "event: window" not in _initial_events(server.port, f"sid={third}&app={'f' * 32}&prev={second}")
        assert "event: window" not in _initial_events(server.port, f"sid={third}&app={token}&prev=x")
        # the next reload continues the chain; a test client never takes over
        assert "event: window" not in _initial_events(server.port, f"sid={third}&app={token}&prev={second}&client=test")
        assert "event: window" in _initial_events(server.port, f"sid={third}&app={token}&prev={second}")
    finally:
        server.stopping.set()
        server.shutdown()


def test_a_burst_of_page_requests_is_never_refused(tmp_path):
    # P8d fix1: socketserver's default listen backlog (5) made Windows reset
    # some of a page's parallel subresource connections under load (an
    # unstyled page, or no rs.js and so no data-rs-ready: the calm abort)
    import http.client
    import threading

    from core.server import ReportHTTPServer

    assert ReportHTTPServer.request_queue_size >= 128
    server, _ = _serve(tmp_path)
    errors = []
    gate = threading.Barrier(100)

    def hit():
        gate.wait()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", server.port, timeout=10)
            connection.request("GET", "/static/shell.css", headers={"Host": f"127.0.0.1:{server.port}"})
            assert connection.getresponse().status == 200
            connection.close()
        except Exception as exc:  # noqa: BLE001 - every failure counts
            errors.append(repr(exc))

    try:
        threads = [threading.Thread(target=hit) for _ in range(100)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
    finally:
        server.stopping.set()
        server.shutdown()
        server.server_close()
    assert errors == []
