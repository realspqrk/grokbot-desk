import ctypes
import os
import subprocess
from ctypes import wintypes
from pathlib import Path

import pytest

import core.platform_windows as clipboard
import core.platform_windows as launcher


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
    assert str(error.value) == "report-shell: neither Edge nor Chrome found; refusing to open a browser tab"


def test_launch_uses_app_profile_and_detached_flags(tmp_path, monkeypatch):
    calls = []
    browser = tmp_path / "msedge.exe"
    monkeypatch.setattr(launcher, "discover_browser", lambda: ("edge", browser))
    monkeypatch.setattr(subprocess, "Popen", lambda args, **kwargs: calls.append((args, kwargs)) or type("P", (), {"pid": 41})())
    result = launcher.launch_window("http://127.0.0.1:9999/?launch=x", tmp_path, {"window": {"x": 2, "y": 3}})
    args, kwargs = calls[0]
    assert result.identity.pid == 41
    assert "--app=http://127.0.0.1:9999/?launch=x" in args
    assert f"--user-data-dir={tmp_path / 'edge-profile'}" in args
    assert "--window-size=880,920" in args   # P8d pop-up default
    assert "--window-position=2,3" in args
    assert kwargs["shell"] is False
    assert kwargs["creationflags"] & launcher.DETACHED_PROCESS
    assert kwargs["creationflags"] & launcher.CREATE_BREAKAWAY_FROM_JOB


def test_server_launch_propagates_selected_data_dir_in_copied_environment(
    tmp_path, monkeypatch
):
    calls = []
    data_dir = tmp_path / "selected data"
    monkeypatch.setenv("RS_PARENT_SENTINEL", "preserved")
    monkeypatch.setattr(
        subprocess,
        "Popen",
        lambda args, **kwargs: calls.append((args, kwargs))
        or type("P", (), {"pid": 42})(),
    )

    assert launcher.launch_server(tmp_path / "report shell.py", 18921, data_dir) == 42

    _, options = calls[0]
    assert options["env"]["RS_DATA_DIR"] == str(data_dir)
    assert options["env"]["RS_PARENT_SENTINEL"] == "preserved"
    assert options["env"] is not os.environ


def test_access_denied_breakaway_fallback_logs_and_warns_once(monkeypatch, capsys):
    flags = []
    events = []
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
