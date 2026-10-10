import importlib
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from pathlib import PurePosixPath
from types import SimpleNamespace
from unittest.mock import patch

import pytest


ROOT = Path(__file__).resolve().parents[1]


def _shell_path(path):
    return path.as_posix()


def _write_fake_python(path, body):
    path.write_text("#!/bin/sh\n" + body, encoding="utf-8", newline="\n")
    path.chmod(0o755)
    return path


def test_macos_launcher_policy_is_explicit_and_never_installs():
    launcher = ROOT / "report-shell"
    source = launcher.read_bytes()
    assert source.startswith(b"#!/bin/sh\n")
    assert b"\r" not in source
    text = source.decode("utf-8")
    assert "REPORT_SHELL_PYTHON" in text
    assert '"/usr/bin/python3"' in text
    assert "/opt/homebrew/bin/python3" in text
    assert "/usr/local/bin/python3" in text
    assert "sys.version_info >= (3, 11)" in text
    assert "xcode-select" not in text
    assert "brew install" not in text


def test_launcher_supervisor_retains_child_until_signal_authority_is_retired():
    source = (ROOT / "report-shell").read_text(encoding="utf-8")
    function = source[
        source.index("valid_python() {") : source.index("\npython=", source.index("valid_python() {"))
    ]

    term = function.index('kill "TERM", -$child')
    final_probe = function.index("my $waited = waitpid($child, WNOHANG);", term)
    kill = function.index('kill "KILL", -$child', final_probe)
    assert "waitpid($child, WNOHANG)" in function[:term]
    assert "if ($waited == 0)" in function[final_probe:kill]
    assert "waitpid($child, 0)" in function[kill:]
    assert "validation_done" not in function
    assert "marker.touch" not in function


@pytest.mark.skipif(shutil.which("sh") is None, reason="POSIX shell is unavailable")
def test_launcher_override_preserves_spaced_arguments_on_windows_too(tmp_path):
    candidate = _write_fake_python(
        tmp_path / "fake python",
        """
if [ "$1" = "-c" ]; then
    exit 0
fi
printf '<%s>\\n' "$@"
""",
    )
    env = dict(
        os.environ,
        REPORT_SHELL_PYTHON=_shell_path(candidate),
    )

    result = subprocess.run(
        ["sh", _shell_path(ROOT / "report-shell"), "argument with spaces", "--flag"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines()[-2:] == [
        "<argument with spaces>",
        "<--flag>",
    ]


@pytest.mark.skipif(shutil.which("sh") is None, reason="POSIX shell is unavailable")
def test_launcher_rejects_old_override_before_executing_report(tmp_path):
    marker = tmp_path / "executed"
    candidate = _write_fake_python(
        tmp_path / "old-python",
        f"""
if [ "$1" = "-c" ]; then
    exit 1
fi
touch '{_shell_path(marker)}'
""",
    )

    result = subprocess.run(
        ["sh", _shell_path(ROOT / "report-shell")],
        cwd=ROOT,
        env=dict(os.environ, REPORT_SHELL_PYTHON=_shell_path(candidate)),
        capture_output=True,
        text=True,
        timeout=5,
    )

    assert result.returncode == 1
    assert not marker.exists()


@pytest.mark.skipif(os.name != "posix", reason="POSIX signal behavior")
def test_launcher_validation_kills_term_ignoring_candidate_within_deadline(tmp_path):
    marker = tmp_path / "must-not-execute"
    candidate = _write_fake_python(
        tmp_path / "ignores-term",
        f"""
if [ "$1" = "-c" ]; then
    trap '' TERM
    while :; do sleep 1; done
fi
touch '{_shell_path(marker)}'
""",
    )
    started = time.monotonic()
    result = subprocess.run(
        ["sh", _shell_path(ROOT / "report-shell")],
        cwd=ROOT,
        env=dict(os.environ, REPORT_SHELL_PYTHON=_shell_path(candidate)),
        capture_output=True,
        text=True,
        timeout=9,
    )

    assert result.returncode == 1
    assert time.monotonic() - started < 8
    assert not marker.exists()


@pytest.mark.skipif(os.name != "posix", reason="POSIX signal behavior")
def test_launcher_deadline_covers_validation_interpreter_shutdown(tmp_path):
    marker = tmp_path / "must-not-execute"
    candidate = _write_fake_python(
        tmp_path / "hangs-during-exit",
        f"""
if [ "$1" = "-c" ]; then
    trap 'while :; do sleep 1; done' EXIT
    exit 0
fi
touch '{_shell_path(marker)}'
""",
    )
    started = time.monotonic()
    result = subprocess.run(
        ["sh", _shell_path(ROOT / "report-shell")],
        cwd=ROOT,
        env=dict(os.environ, REPORT_SHELL_PYTHON=_shell_path(candidate)),
        capture_output=True,
        text=True,
        timeout=9,
    )

    assert result.returncode == 1
    assert time.monotonic() - started < 8
    assert not marker.exists()


@pytest.mark.skipif(os.name != "posix", reason="POSIX signal behavior")
def test_launcher_reaps_candidate_that_exits_on_term_without_kill_escalation(
    tmp_path,
):
    term_received = tmp_path / "term-received"
    marker = tmp_path / "must-not-execute"
    candidate = _write_fake_python(
        tmp_path / "exits-on-term",
        f"""
if [ "$1" = "-c" ]; then
    trap 'touch "{_shell_path(term_received)}"; exit 0' TERM
    while :; do sleep 1; done
fi
touch '{_shell_path(marker)}'
""",
    )
    result = subprocess.run(
        ["sh", _shell_path(ROOT / "report-shell")],
        cwd=ROOT,
        env=dict(os.environ, REPORT_SHELL_PYTHON=_shell_path(candidate)),
        capture_output=True,
        text=True,
        timeout=9,
    )

    assert result.returncode == 1
    assert term_received.exists()
    assert not marker.exists()


@pytest.mark.skipif(os.name != "posix", reason="POSIX symlink behavior")
def test_launcher_rejects_apple_python_and_bounds_symlink_cycles(tmp_path):
    apple_link = tmp_path / "apple-python"
    apple_link.symlink_to("/usr/bin/python3")
    apple = subprocess.run(
        ["sh", _shell_path(ROOT / "report-shell")],
        cwd=ROOT,
        env=dict(os.environ, REPORT_SHELL_PYTHON=str(apple_link)),
        capture_output=True,
        text=True,
        timeout=3,
    )
    assert apple.returncode == 1

    first = tmp_path / "first"
    second = tmp_path / "second"
    first.symlink_to(second)
    second.symlink_to(first)
    cycle = subprocess.run(
        ["sh", _shell_path(ROOT / "report-shell")],
        cwd=ROOT,
        env=dict(os.environ, REPORT_SHELL_PYTHON=str(first)),
        capture_output=True,
        text=True,
        timeout=3,
    )
    assert cycle.returncode == 1


def test_facade_selects_one_backend_from_sys_platform(monkeypatch):
    import core.platform as facade

    original = sys.platform
    monkeypatch.setattr(sys, "platform", "darwin")
    selected = importlib.reload(facade)
    try:
        assert selected.BACKEND_NAME == "darwin"
        assert selected.launch_window.__module__ == "core.platform_darwin"
    finally:
        monkeypatch.setattr(sys, "platform", original)
        importlib.reload(facade)


def test_darwin_data_dir_and_override_do_not_expand_tilde(tmp_path, monkeypatch):
    from core import platform_darwin

    monkeypatch.delenv("RS_DATA_DIR", raising=False)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path / "home"))
    assert platform_darwin.default_data_dir("grokbot-desk") == (
        tmp_path / "home" / "Library" / "Application Support" / "grokbot-desk"
    )
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("RS_DATA_DIR", "~/chosen")
    assert platform_darwin.default_data_dir("grokbot-desk") == (
        tmp_path / "~" / "chosen"
    ).resolve()


@pytest.mark.parametrize(
    ("current_exists", "legacy_exists", "expected_name"),
    [
        (False, False, "grokbot-desk"),
        (False, True, "spqrk-report-shell"),
        (True, True, "grokbot-desk"),
    ],
    ids=["new", "legacy", "current-wins"],
)
def test_windows_data_dir_selection(
    tmp_path, monkeypatch, current_exists, legacy_exists, expected_name
):
    from core import platform_windows

    monkeypatch.delenv("RS_DATA_DIR", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    if current_exists:
        (tmp_path / "grokbot-desk").mkdir()
    if legacy_exists:
        (tmp_path / "spqrk-report-shell").mkdir()

    assert platform_windows.default_data_dir("grokbot-desk") == (
        tmp_path / expected_name
    )


def test_windows_data_dir_override_wins(tmp_path, monkeypatch):
    from core import platform_windows

    override = tmp_path / "override"
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    monkeypatch.setenv("RS_DATA_DIR", str(override))

    assert platform_windows.default_data_dir("grokbot-desk") == override.resolve()


def test_restart_policy_differs_by_backend():
    from core import platform_darwin, platform_windows

    assert platform_darwin.ALLOW_REUSE_ADDRESS is True
    assert platform_windows.ALLOW_REUSE_ADDRESS is False


@pytest.mark.skipif(
    os.name != "posix",
    reason="POSIX live-listener reuse behavior needs a POSIX socket stack",
)
def test_darwin_live_listener_is_never_reused():
    first = socket.socket()
    second = socket.socket()
    try:
        first.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        first.bind(("127.0.0.1", 0))
        first.listen()
        second.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        with pytest.raises(OSError):
            second.bind(first.getsockname())
            second.listen()
    finally:
        second.close()
        first.close()


@pytest.mark.skipif(
    os.name != "posix",
    reason="POSIX rapid restart and TIME_WAIT behavior needs a POSIX socket stack",
)
def test_report_server_stops_and_restarts_on_same_port(tmp_path):
    import threading
    import urllib.request

    from core.paths import ensure_layout, load_config
    from core.registry import scan_registry
    from core.server import Handler, ReportHTTPServer

    data = ensure_layout(tmp_path / "data")
    registry = scan_registry(ROOT / "templates")
    first = ReportHTTPServer(
        ("127.0.0.1", 0), Handler, data, registry, load_config(data)
    )
    port = first.server_port
    first.port = port
    thread = threading.Thread(target=first.serve_forever)
    thread.start()
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/hello", timeout=2
        ) as response:
            assert response.status == 200
    finally:
        first.shutdown()
        first.server_close()
        thread.join(2)

    restarted = ReportHTTPServer(
        ("127.0.0.1", port), Handler, data, registry, load_config(data)
    )
    restarted.server_close()


def test_darwin_discovery_prefers_user_edge_then_system_chrome(tmp_path, monkeypatch):
    from core import platform_darwin

    home = tmp_path / "home"
    user_edge = home / "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    system_chrome = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    monkeypatch.setattr(
        Path,
        "is_file",
        lambda self: self in {user_edge, system_chrome},
    )
    monkeypatch.setattr(os, "access", lambda path, mode: path == user_edge)
    assert platform_darwin.discover_browser() == ("edge", user_edge)


def test_darwin_direct_launch_uses_one_canonical_profile_and_posix_detachment(
    tmp_path, monkeypatch
):
    from core import platform_darwin

    browser = tmp_path / "Microsoft Edge"
    calls = []
    process = SimpleNamespace(pid=321)
    monkeypatch.setattr(
        platform_darwin, "discover_browser", lambda: ("edge", browser)
    )
    monkeypatch.setattr(
        platform_darwin.subprocess,
        "Popen",
        lambda args, **kwargs: calls.append((args, kwargs)) or process,
    )
    monkeypatch.setattr(platform_darwin, "_process_start", lambda pid: None)
    result = platform_darwin.launch_window(
        "http://127.0.0.1:18921/",
        tmp_path / "data with spaces",
        {"window": {"x": "2", "y": 3, "width": -1, "height": 0}},
    )
    args, options = calls[0]
    profile = (tmp_path / "data with spaces" / "edge-profile").resolve()
    assert result.mode == "app"
    assert result.identity.pid == 321
    assert result.identity.user_data_dir == profile
    assert args.count(f"--user-data-dir={profile}") == 1
    assert "--window-size=880,920" in args   # P8d pop-up default
    assert "--window-position=2,3" in args
    assert options == {
        "shell": False,
        "start_new_session": True,
        "close_fds": True,
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }


def test_darwin_server_launch_uses_current_interpreter_and_data_dir(
    tmp_path, monkeypatch
):
    from core import platform_darwin

    calls = []
    monkeypatch.setattr(
        platform_darwin.subprocess,
        "Popen",
        lambda args, **kwargs: calls.append((args, kwargs))
        or SimpleNamespace(pid=87),
    )
    script = tmp_path / "report shell.py"
    data = tmp_path / "data dir"
    assert platform_darwin.launch_server(script, 18921, data) == 87
    args, options = calls[0]
    assert args == [
        sys.executable,
        str(script),
        "--port",
        "18921",
        "serve",
    ]
    assert options["env"]["RS_DATA_DIR"] == str(data)
    assert options["start_new_session"] is True


def test_darwin_default_browser_mode_owns_nothing(tmp_path, monkeypatch):
    from core import platform_darwin

    calls = []
    monkeypatch.setattr(platform_darwin, "discover_browser", lambda: None)
    # stub both lookups: a real runner may have a browser bundle installed
    monkeypatch.setattr(platform_darwin, "_browser_candidates", lambda: [])
    monkeypatch.setattr(
        platform_darwin.subprocess,
        "Popen",
        lambda args, **kwargs: calls.append((args, kwargs)) or SimpleNamespace(pid=99),
    )
    result = platform_darwin.launch_window(
        "http://127.0.0.1:18921/", tmp_path, {}
    )
    assert result.mode == "default"
    assert result.identity is None
    assert calls == [
        (
            ["/usr/bin/open", "http://127.0.0.1:18921/"],
            {
                "shell": False,
                "start_new_session": True,
                "close_fds": True,
                "stdin": subprocess.DEVNULL,
                "stdout": subprocess.DEVNULL,
                "stderr": subprocess.DEVNULL,
            },
        )
    ]


def test_darwin_open_fallback_does_not_claim_browser_ownership(
    tmp_path, monkeypatch
):
    from core import platform_darwin

    executable = Path(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    )
    calls = []
    monkeypatch.setattr(platform_darwin, "discover_browser", lambda: None)
    monkeypatch.setattr(
        platform_darwin,
        "_browser_candidates",
        lambda: [("chrome", executable)],
    )
    monkeypatch.setattr(
        Path, "is_dir", lambda self: self == executable.parents[2]
    )
    monkeypatch.setattr(
        platform_darwin.subprocess,
        "Popen",
        lambda args, **kwargs: calls.append((args, kwargs))
        or SimpleNamespace(pid=99),
    )
    result = platform_darwin.launch_window(
        "http://127.0.0.1:18921/", tmp_path, {}
    )
    assert result.mode == "app"
    assert result.identity is None
    assert calls[0][0][:4] == [
        "/usr/bin/open",
        "-na",
        str(executable.parents[2]),
        "--args",
    ]


def test_darwin_clipboard_uses_exact_utf8_and_bounded_round_trip(monkeypatch):
    from core import platform_darwin

    calls = []
    copied = {}

    def run(args, **kwargs):
        calls.append((args, kwargs))
        if args == ["/usr/bin/pbcopy"]:
            copied["value"] = kwargs["input"]
            return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")
        return SimpleNamespace(
            returncode=0, stdout=copied["value"], stderr=b""
        )

    monkeypatch.setattr(platform_darwin.subprocess, "run", run)
    platform_darwin.write_clipboard("Grüße\n")
    assert calls[0][0] == ["/usr/bin/pbcopy"]
    assert calls[0][1]["input"] == "Grüße\n".encode()
    assert calls[1][0] == ["/usr/bin/pbpaste"]
    for _, options in calls:
        assert options["shell"] is False
        assert options["timeout"] > 0
        assert options["env"]["LC_ALL"] == ""
        assert options["env"]["LC_CTYPE"] == "UTF-8"
        assert options["env"]["LANG"] == "en_US.UTF-8"


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (FileNotFoundError(), "ClipboardUnavailable"),
        (PermissionError(), "ClipboardUnavailable"),
        (subprocess.TimeoutExpired("pbcopy", 1), "ClipboardTimeout"),
    ],
)
def test_darwin_clipboard_maps_platform_failures(monkeypatch, error, expected):
    from core import platform_darwin

    monkeypatch.setattr(
        platform_darwin.subprocess, "run", lambda *args, **kwargs: (_ for _ in ()).throw(error)
    )
    with pytest.raises(getattr(platform_darwin, expected)):
        platform_darwin.write_clipboard("text")


@pytest.mark.parametrize("failed_command", ["pbcopy", "pbpaste"])
def test_darwin_clipboard_oserror_always_reaches_structured_copy_response(
    monkeypatch, failed_command
):
    import core.server as server_module
    from core import platform_darwin

    def run(args, **kwargs):
        if args[0].endswith(failed_command):
            raise OSError("spawn failed")
        return SimpleNamespace(returncode=0, stdout=b"text", stderr=b"")

    monkeypatch.setattr(platform_darwin.subprocess, "run", run)
    monkeypatch.setattr(server_module, "write_clipboard", platform_darwin.write_clipboard)
    responses = []
    writes = []
    handler = object.__new__(server_module.Handler)
    handler.server = SimpleNamespace(
        action_log=SimpleNamespace(
            write=lambda run_id, event, detail: writes.append((run_id, event, detail))
        )
    )
    handler._json = lambda status, body: responses.append((status, body))

    handler._copy({"text": "text", "run_id": "run-1"})

    assert responses == [(503, {"error": "clipboard_unavailable"})]
    assert writes == []


@pytest.mark.parametrize(
    ("pbcopy_status", "pasted"),
    [(1, b"text"), (0, b"changed")],
)
def test_darwin_clipboard_failure_never_logs_copy_success(
    monkeypatch, pbcopy_status, pasted
):
    import core.server as server_module
    from core import platform_darwin

    def run(args, **kwargs):
        if args == ["/usr/bin/pbcopy"]:
            return SimpleNamespace(returncode=pbcopy_status, stdout=b"", stderr=b"failed")
        return SimpleNamespace(returncode=0, stdout=pasted, stderr=b"")

    monkeypatch.setattr(platform_darwin.subprocess, "run", run)
    monkeypatch.setattr(server_module, "write_clipboard", platform_darwin.write_clipboard)
    responses = []
    handler = object.__new__(server_module.Handler)
    handler.server = SimpleNamespace(
        action_log=SimpleNamespace(write=pytest.fail)
    )
    handler._json = lambda status, body: responses.append((status, body))

    handler._copy({"text": "text", "run_id": "run-1"})

    assert responses == [(500, {"error": "clipboard_failed"})]


def test_darwin_focus_and_attention_are_noops(monkeypatch):
    from core import platform_darwin

    monkeypatch.setattr(platform_darwin.subprocess, "Popen", pytest.fail)
    assert platform_darwin.request_attention(None, "Unread") is False
    assert platform_darwin.focus_window(None, "Unread") is False


def test_darwin_reveal_uses_open_dash_r(monkeypatch, tmp_path):
    from core import platform_darwin

    calls = []
    monkeypatch.setattr(
        platform_darwin.subprocess,
        "run",
        lambda args, **kwargs: calls.append((args, kwargs))
        or SimpleNamespace(returncode=0, stderr=b""),
    )
    path = tmp_path / "name with spaces.png"
    platform_darwin.reveal_file(path)
    assert calls[0][0] == ["/usr/bin/open", "-R", str(path)]
    assert calls[0][1]["shell"] is False


def test_darwin_final_path_uses_f_getpath_and_fails_closed(monkeypatch):
    from core import platform_darwin

    encoded = b"/private/tmp/actual.png\0"
    fake_fcntl = SimpleNamespace(
        fcntl=lambda descriptor, command, buffer: encoded + bytes(len(buffer) - len(encoded))
    )
    monkeypatch.setitem(sys.modules, "fcntl", fake_fcntl)
    handle = SimpleNamespace(fileno=lambda: 7, name="/wrong/path.png")
    assert platform_darwin.final_path_for_handle(handle) == Path(
        "/private/tmp/actual.png"
    )
    fake_fcntl.fcntl = lambda *args: bytes(1024)
    with pytest.raises(OSError):
        platform_darwin.final_path_for_handle(handle)


def test_darwin_directory_final_path_uses_fcntl_on_the_fd(tmp_path, monkeypatch):
    """Directory descriptors must not be wrapped in a file object.

    CPython FileIO raises IsADirectoryError for a directory fd, which used
    to fail every template-media open on macOS before F_GETPATH ran.
    """
    from core import platform_darwin

    directory = tmp_path / "root"
    directory.mkdir()
    encoded = os.fsencode(directory) + b"\0"
    expected = Path(os.fsdecode(encoded.split(b"\0", 1)[0]))
    seen = {}
    closed = []
    original_dup = platform_darwin.os.dup
    original_close = platform_darwin.os.close

    def fcntl_fn(descriptor, command, buffer):
        assert isinstance(descriptor, int)
        seen["fd"] = descriptor
        seen["command"] = command
        return encoded + bytes(max(0, len(buffer) - len(encoded)))

    monkeypatch.setitem(sys.modules, "fcntl", SimpleNamespace(fcntl=fcntl_fn))
    monkeypatch.setattr(
        platform_darwin.os,
        "fdopen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            IsADirectoryError(21, "Is a directory")
        ),
    )

    raw = None
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    try:
        raw = os.open(directory, flags)
    except OSError:
        raw = None

    if raw is None:
        def dup(fd):
            seen["dup_of"] = fd
            return 81

        def close(fd):
            closed.append(fd)

        monkeypatch.setattr(platform_darwin.os, "dup", dup)
        monkeypatch.setattr(platform_darwin.os, "close", close)
        source = 11
    else:
        def dup(fd):
            new = original_dup(fd)
            seen["dup_of"] = fd
            seen["duped"] = new
            return new

        def close(fd):
            closed.append(fd)
            return original_close(fd)

        monkeypatch.setattr(platform_darwin.os, "dup", dup)
        monkeypatch.setattr(platform_darwin.os, "close", close)
        source = raw

    try:
        assert platform_darwin._final_path_fd(source) == expected
        assert seen["dup_of"] == source
        assert seen["fd"] != source
        assert seen["command"] == platform_darwin.F_GETPATH
        assert seen["fd"] in closed
        closed.clear()

        def fail(*_args):
            raise OSError("fcntl failed")

        monkeypatch.setitem(sys.modules, "fcntl", SimpleNamespace(fcntl=fail))
        with pytest.raises(OSError, match="fcntl failed"):
            platform_darwin._final_path_fd(source)
        duplicated = seen.get("duped", 81)
        assert duplicated in closed
        if raw is not None:
            assert raw not in closed
    finally:
        if raw is not None:
            original_close(raw)


def _process_handle_count():
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    get_count = kernel32.GetProcessHandleCount
    get_count.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    get_count.restype = wintypes.BOOL
    count = wintypes.DWORD()
    if not get_count(kernel32.GetCurrentProcess(), ctypes.byref(count)):
        raise ctypes.WinError(ctypes.get_last_error())
    return int(count.value)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows handle ownership")
def test_contained_child_handle_is_closed_when_identity_query_fails(tmp_path, monkeypatch):
    from core import platform_windows

    root = tmp_path / "template"
    nested = root / "sub"
    nested.mkdir(parents=True)
    (nested / "photo.png").write_bytes(b"INSIDE")
    opened, *_rest = platform_windows.open_contained(root, ("sub", "photo.png"))
    opened.close()
    real_identity = platform_windows._handle_identity

    def fail_child(handle):
        fail_child.calls += 1
        if fail_child.calls > 1:
            raise OSError("injected identity failure")
        return real_identity(handle)

    fail_child.calls = 0
    monkeypatch.setattr(platform_windows, "_handle_identity", fail_child)
    before = _process_handle_count()
    for _ in range(20):
        fail_child.calls = 0
        with pytest.raises(OSError, match="injected identity failure"):
            platform_windows.open_contained(root, ("sub", "photo.png"))
        assert fail_child.calls == 2
    assert _process_handle_count() == before


def test_launch_result_state_round_trip_and_default_has_no_identity(tmp_path):
    from core.platform_types import BrowserIdentity, LaunchResult

    identity = BrowserIdentity(
        kind="edge",
        executable=tmp_path / "Edge",
        user_data_dir=tmp_path / "profile",
        pid=123,
        started="start-token",
    )
    assert LaunchResult.from_state(LaunchResult("app", identity).to_state()).identity == identity
    assert LaunchResult.from_state({"mode": "app"}) == LaunchResult("app")
    assert LaunchResult("default").to_state() == {"mode": "default"}


def test_server_state_preserves_full_browser_identity(tmp_path):
    from core import server as server_module
    from core.platform_types import BrowserIdentity, LaunchResult

    data = tmp_path / "data"
    data.mkdir()
    launched = LaunchResult(
        "app",
        BrowserIdentity(
            "chrome", tmp_path / "Chrome", tmp_path / "profile", 55, "token"
        ),
    )
    (data / "state.json").write_text(
        '{"browser":' + __import__("json").dumps(launched.to_state()) + "}"
    )
    server = SimpleNamespace(data_dir=data, token="secret", port=18921)
    with patch.object(server_module.os, "getpid", return_value=900):
        server_module._write_state(server)
    state = __import__("json").loads((data / "state.json").read_text())
    assert LaunchResult.from_state(state["browser"]) == launched
    assert state["pid"] == 900


def test_template_token_join_uses_path_parts_on_posix(monkeypatch):
    import core.media as media

    monkeypatch.setattr(media, "Path", PurePosixPath)
    assert media._expand_template_token(
        "%RS_TEMPLATE%\\fixtures/media/a.png", PurePosixPath("/template")
    ) == "/template/fixtures/media/a.png"


@pytest.mark.parametrize(
    ("error_name", "status", "code"),
    [
        ("ClipboardBusy", 423, "clipboard_busy"),
        ("ClipboardUnavailable", 503, "clipboard_unavailable"),
        ("ClipboardTimeout", 504, "clipboard_timeout"),
        ("ClipboardError", 500, "clipboard_failed"),
    ],
)
def test_copy_maps_platform_clipboard_errors(
    monkeypatch, error_name, status, code
):
    import core.server as server_module
    from core import platform_types

    responses = []
    handler = object.__new__(server_module.Handler)
    handler.server = SimpleNamespace(
        action_log=SimpleNamespace(write=pytest.fail)
    )
    handler._json = lambda actual, body: responses.append((actual, body))
    error = getattr(platform_types, error_name)("failed")
    monkeypatch.setattr(
        server_module,
        "write_clipboard",
        lambda text: (_ for _ in ()).throw(error),
    )
    handler._copy({"text": "safe"})
    assert responses == [(status, {"error": code})]


def test_unknown_browser_ownership_is_never_terminated(monkeypatch, tmp_path):
    from core import platform_darwin
    from core.platform_types import BrowserIdentity

    identity = BrowserIdentity(
        "edge", tmp_path / "Edge", tmp_path / "profile", pid=123, started="token"
    )
    monkeypatch.setattr(
        platform_darwin, "query_owned_browser", lambda selected: None
    )
    monkeypatch.setattr(os, "kill", pytest.fail)
    assert platform_darwin.terminate_owned_browser(identity, timeout=0) is None


@pytest.mark.parametrize(
    ("started", "values"),
    [
        (None, {}),
        ("original", {"uid": None, "lstart": "original", "comm": "Edge"}),
        ("original", {"uid": "999999", "lstart": "original", "comm": "Edge"}),
        ("original", {"uid": "501", "lstart": "changed", "comm": "Edge"}),
        ("original", {"uid": "501", "lstart": "original", "comm": "Other"}),
    ],
    ids=["missing-start", "ps-failure", "wrong-uid", "changed-start", "changed-executable"],
)
def test_darwin_incomplete_or_changed_identity_never_terminates(
    tmp_path, monkeypatch, started, values
):
    from core import platform_darwin
    from core.platform_types import BrowserIdentity

    calls = []

    class RetainedProcess:
        def poll(self):
            return None

        def terminate(self):
            calls.append("terminate")

        def kill(self):
            calls.append("kill")

    executable = tmp_path / "Edge"
    identity = BrowserIdentity(
        "edge", executable, tmp_path / "profile", pid=123, started=started
    )
    process = RetainedProcess()
    monkeypatch.setitem(platform_darwin._owned_processes, identity.pid, (identity, process))
    monkeypatch.setattr(platform_darwin.os, "getuid", lambda: 501, raising=False)
    monkeypatch.setattr(
        platform_darwin,
        "_ps_value",
        lambda pid, field: values.get(field),
    )

    assert platform_darwin.query_owned_browser(identity) is None
    assert platform_darwin.terminate_owned_browser(identity, timeout=0) is None
    assert calls == []


def test_darwin_launch_oserror_is_a_bounded_facade_error(tmp_path, monkeypatch):
    from core import platform_darwin
    from core.platform_types import BrowserLaunchError

    browser = tmp_path / "Edge"
    monkeypatch.setattr(platform_darwin, "_owned_processes", {})
    monkeypatch.setattr(
        platform_darwin, "discover_browser", lambda: ("edge", browser)
    )
    monkeypatch.setattr(
        platform_darwin,
        "_posix_popen",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            PermissionError("loader denied")
        ),
    )

    with pytest.raises(BrowserLaunchError, match="could not launch edge"):
        platform_darwin.launch_window("http://127.0.0.1:18921/", tmp_path, {})
    assert platform_darwin._owned_processes == {}


@pytest.mark.parametrize("fallback", ["bundle", "default"])
def test_darwin_open_fallback_oserror_is_a_bounded_facade_error(
    tmp_path, monkeypatch, fallback
):
    from core import platform_darwin
    from core.platform_types import BrowserLaunchError

    executable = Path(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    )
    monkeypatch.setattr(platform_darwin, "discover_browser", lambda: None)
    monkeypatch.setattr(
        platform_darwin,
        "_browser_candidates",
        lambda: [("chrome", executable)] if fallback == "bundle" else [],
    )
    monkeypatch.setattr(
        Path,
        "is_dir",
        lambda self: fallback == "bundle" and self == executable.parents[2],
    )
    monkeypatch.setattr(
        platform_darwin,
        "_posix_popen",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            PermissionError("open denied")
        ),
    )

    expected = "chrome app window" if fallback == "bundle" else "default browser"
    with pytest.raises(BrowserLaunchError, match=expected):
        platform_darwin.launch_window("http://127.0.0.1:18921/", tmp_path, {})
