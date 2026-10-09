import ctypes
import os
import subprocess
import sys
from ctypes import wintypes
from pathlib import Path

import pytest

import core.clipboard as clipboard
import core.launcher as launcher


def test_browser_discovery_prefers_registry_edge(monkeypatch):
    registry_edge = Path(r"C:\registered\msedge.exe")
    monkeypatch.setattr(launcher, "_registry_app_path", lambda name: registry_edge if name == "msedge.exe" else None)
    monkeypatch.setattr(Path, "is_file", lambda self: str(self) == str(registry_edge))
    assert launcher.discover_browser() == ("edge", registry_edge)


def test_missing_browser_has_exact_message(monkeypatch):
    monkeypatch.setattr(launcher, "_registry_app_path", lambda name: None)
    monkeypatch.setattr(Path, "is_file", lambda self: False)
    with pytest.raises(launcher.BrowserNotFound) as error:
        launcher.discover_browser()
    assert str(error.value) == "grokbot-desk: neither Edge nor Chrome found; refusing to open a browser tab"


def test_launch_uses_app_profile_and_detached_flags(tmp_path, monkeypatch):
    calls = []
    browser = tmp_path / "msedge.exe"
    monkeypatch.setattr(launcher.sys, "platform", "win32")
    monkeypatch.setattr(launcher, "discover_browser", lambda: ("edge", browser))
    monkeypatch.setattr(subprocess, "Popen", lambda args, **kwargs: calls.append((args, kwargs)) or type("P", (), {"pid": 41})())
    pid = launcher.launch_window("http://127.0.0.1:9999/?launch=x", tmp_path, {"window": {"x": 2, "y": 3}})
    args, kwargs = calls[0]
    assert pid == 41
    assert "--app=http://127.0.0.1:9999/?launch=x" in args
    assert f"--user-data-dir={tmp_path / 'edge-profile'}" in args
    assert "--window-size=1500,1000" in args
    assert "--window-position=2,3" in args
    assert kwargs["shell"] is False
    assert kwargs["creationflags"] & launcher.DETACHED_PROCESS
    assert kwargs["creationflags"] & launcher.CREATE_BREAKAWAY_FROM_JOB


def test_posix_detached_launch_starts_new_session_without_creationflags(monkeypatch):
    calls = []
    monkeypatch.setattr(launcher.sys, "platform", "darwin")
    monkeypatch.setattr(
        subprocess,
        "Popen",
        lambda args, **kwargs: calls.append((args, kwargs))
        or type("P", (), {"pid": 42})(),
    )

    assert launcher._detached_popen(["program"]).pid == 42
    assert calls == [
        (
            ["program"],
            {
                "close_fds": True,
                "shell": False,
                "start_new_session": True,
                "stdin": subprocess.DEVNULL,
                "stdout": subprocess.DEVNULL,
                "stderr": subprocess.DEVNULL,
            },
        )
    ]


def test_posix_detached_child_does_not_hold_captured_parent_pipes(tmp_path):
    runner = tmp_path / "captured_launcher.py"
    runner.write_text(
        "import os\n"
        "import sys\n"
        "from types import SimpleNamespace\n"
        "from core import launcher\n"
        "launcher.sys = SimpleNamespace(platform='darwin')\n"
        "if os.name == 'nt':\n"
        "    real_popen = launcher.subprocess.Popen\n"
        "    def portable_popen(*args, **kwargs):\n"
        "        kwargs.pop('start_new_session', None)\n"
        "        return real_popen(*args, **kwargs)\n"
        "    launcher.subprocess.Popen = portable_popen\n"
        "launcher._detached_popen([\n"
        "    sys.executable, '-c', 'import time; time.sleep(2)'\n"
        "])\n"
        "print('launcher returned')\n",
        encoding="utf-8",
    )

    result = subprocess.run(
        [sys.executable, str(runner)],
        env={
            **os.environ,
            "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
        },
        capture_output=True,
        text=True,
        timeout=1,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "launcher returned"


def test_access_denied_breakaway_fallback_logs_and_warns_once(monkeypatch, capsys):
    flags = []
    events = []
    monkeypatch.setattr(launcher.sys, "platform", "win32")
    action_log = type(
        "Log",
        (),
        {"write": lambda self, run_id, event, detail: events.append((run_id, event, detail))},
    )()

    def popen(args, **kwargs):
        flags.append(kwargs["creationflags"])
        if len(flags) == 1:
            error = OSError("breakaway refused")
            error.winerror = 5
            raise error
        return type("P", (), {"pid": 7})()

    monkeypatch.setattr(subprocess, "Popen", popen)
    assert launcher._detached_popen(["program"], action_log).pid == 7
    assert flags[0] & launcher.CREATE_BREAKAWAY_FROM_JOB
    assert not flags[1] & launcher.CREATE_BREAKAWAY_FROM_JOB
    assert events == [(None, "error", {"what": "breakaway_refused"})]
    warning = capsys.readouterr().err.strip().splitlines()
    assert len(warning) == 1
    assert "breakaway" in warning[0].lower()


def test_non_access_denied_detached_launch_error_is_not_retried(monkeypatch):
    calls = []
    error = OSError("unexpected launch failure")
    error.winerror = 87
    monkeypatch.setattr(launcher.sys, "platform", "win32")

    def popen(args, **kwargs):
        calls.append(kwargs["creationflags"])
        raise error

    monkeypatch.setattr(subprocess, "Popen", popen)
    with pytest.raises(OSError) as caught:
        launcher._detached_popen(["program"])
    assert caught.value is error
    assert calls == [launcher.DETACHED_FLAGS]


@pytest.mark.skipif(os.name != "nt", reason="Win32 handle ABI test")
def test_clipboard_global_unlock_accepts_real_pointer_sized_handle():
    user32, kernel32 = clipboard._win32_apis()
    handle = kernel32.GlobalAlloc(0x0002, 32)
    assert handle
    pointer = kernel32.GlobalLock(handle)
    assert pointer
    try:
        ctypes.set_last_error(0)
        still_locked = kernel32.GlobalUnlock(handle)
        assert still_locked or ctypes.get_last_error() == 0
        assert kernel32.GlobalUnlock.argtypes == [wintypes.HGLOBAL]
    finally:
        kernel32.GlobalFree(handle)
