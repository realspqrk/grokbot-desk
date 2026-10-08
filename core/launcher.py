"""Detached server/browser launching and Windows report-window notification."""
import ctypes
import os
import subprocess
import sys
from pathlib import Path

from .actionlog import ActionLog
from .product import DISPLAY_NAME


DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
DETACHED_FLAGS = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB
NO_BREAKAWAY_FLAGS = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
MISSING_BROWSER_MESSAGE = (
    f"{DISPLAY_NAME}: neither Edge nor Chrome found; refusing to open a browser tab"
)


class BrowserNotFound(RuntimeError):
    pass


def _registry_app_path(executable):
    try:
        import winreg

        path = rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{executable}"
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path) as key:
            return Path(winreg.QueryValue(key, None))
    except (ImportError, OSError):
        return None


def discover_browser():
    edge = _registry_app_path("msedge.exe")
    candidates = [
        ("edge", edge),
        ("edge", Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")),
        ("edge", Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe")),
        ("chrome", _registry_app_path("chrome.exe")),
        ("chrome", Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")),
    ]
    for kind, path in candidates:
        if path is not None and path.is_file():
            return kind, path
    raise BrowserNotFound(MISSING_BROWSER_MESSAGE)


def _detached_popen(args, action_log=None):
    options = {"creationflags": DETACHED_FLAGS, "close_fds": True, "shell": False}
    try:
        return subprocess.Popen(args, **options)
    except OSError as error:
        if getattr(error, "winerror", None) != 5:
            raise
        if action_log is not None:
            action_log.write(None, "error", {"what": "breakaway_refused"})
        print(
            f"{DISPLAY_NAME}: warning: job breakaway was refused; "
            "retrying detached launch without breakaway",
            file=sys.stderr,
        )
        options["creationflags"] = NO_BREAKAWAY_FLAGS
        return subprocess.Popen(args, **options)


def launch_server(script, port, data_dir):
    executable = Path(sys.executable).with_name("pythonw.exe")
    if not executable.is_file():
        executable = Path(sys.executable)
    return _detached_popen(
        [str(executable), str(script), "--port", str(port), "serve"],
        ActionLog(data_dir),
    ).pid


def launch_window(url, data_dir, config):
    kind, executable = discover_browser()
    profile = Path(data_dir) / ("edge-profile" if kind == "edge" else "chrome-profile")
    window = config.get("window", {})
    width, height = int(window.get("width", 1500)), int(window.get("height", 1000))
    x, y = int(window.get("x", 0)), int(window.get("y", 0))
    args = [
        str(executable),
        f"--app={url}",
        f"--user-data-dir={profile}",
        f"--window-size={width},{height}",
        f"--window-position={x},{y}",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    return _detached_popen(args, ActionLog(data_dir)).pid


def find_window(browser_pid=None, title=None):
    if os.name != "nt":
        return None
    user32 = ctypes.windll.user32
    matches = []
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def visit(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        class_name = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, class_name, len(class_name))
        if class_name.value != "Chrome_WidgetWin_1":
            return True
        pid = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        length = user32.GetWindowTextLengthW(hwnd)
        text = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, text, length + 1)
        pid_match = browser_pid and pid.value == browser_pid
        title_match = title and text.value == title and not text.value.endswith((" - Microsoft Edge", " - Google Chrome"))
        if pid_match or title_match:
            matches.append(hwnd)
        return True

    user32.EnumWindows(callback_type(visit), 0)
    return matches[0] if matches else None


def flash_window(browser_pid=None, title=None):
    hwnd = find_window(browser_pid, title)
    if not hwnd:
        return False
    class FlashInfo(ctypes.Structure):
        _fields_ = [
            ("cbSize", ctypes.c_uint), ("hwnd", ctypes.c_void_p),
            ("dwFlags", ctypes.c_uint), ("uCount", ctypes.c_uint),
            ("dwTimeout", ctypes.c_uint),
        ]
    info = FlashInfo(ctypes.sizeof(FlashInfo), hwnd, 0x00000002 | 0x0000000C, 0, 0)
    return bool(ctypes.windll.user32.FlashWindowEx(ctypes.byref(info)))


def focus_window(browser_pid=None, title=None):
    hwnd = find_window(browser_pid, title)
    if hwnd and ctypes.windll.user32.SetForegroundWindow(hwnd):
        return True
    flash_window(browser_pid, title)
    return False
