"""Windows implementation of the native platform facade."""
import ctypes
import os
import subprocess
import sys
import time
from ctypes import wintypes
from pathlib import Path

from .actionlog import ActionLog
from .platform_types import (
    DEFAULT_WINDOW_HEIGHT,
    DEFAULT_WINDOW_WIDTH,
    BrowserIdentity,
    BrowserNotFound,
    ClipboardBusy,
    LaunchResult,
    PathIdentityError,
    ReparseEscape,
)


DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
DETACHED_FLAGS = (
    DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB
)
NO_BREAKAWAY_FLAGS = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
MISSING_BROWSER_MESSAGE = (
    "report-shell: neither Edge nor Chrome found; refusing to open a browser tab"
)
ALLOW_REUSE_ADDRESS = False
_owned_processes = {}


def default_data_dir(product_name):
    override = os.environ.get("RS_DATA_DIR")
    if override:
        return Path(override).resolve()
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        raise RuntimeError("LOCALAPPDATA is not set")
    local = Path(local)
    current = local / product_name
    legacy = local / "spqrk-report-shell"
    return legacy if not current.exists() and legacy.is_dir() else current


def _registry_app_path(executable):
    try:
        import winreg

        path = (
            rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{executable}"
        )
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path) as key:
            return Path(winreg.QueryValue(key, None))
    except (ImportError, OSError):
        return None


def discover_browser():
    edge = _registry_app_path("msedge.exe")
    candidates = [
        ("edge", edge),
        (
            "edge",
            Path(
                r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
            ),
        ),
        (
            "edge",
            Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
        ),
        ("chrome", _registry_app_path("chrome.exe")),
        (
            "chrome",
            Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        ),
    ]
    for kind, path in candidates:
        if path is not None and path.is_file():
            return kind, path
    raise BrowserNotFound(MISSING_BROWSER_MESSAGE)


def _detached_popen(args, action_log=None, env=None):
    options = {
        "creationflags": DETACHED_FLAGS,
        "close_fds": True,
        "shell": False,
    }
    if env is not None:
        options["env"] = env
    try:
        return subprocess.Popen(args, **options)
    except OSError as error:
        if getattr(error, "winerror", None) != 5:
            raise
        if action_log is not None:
            action_log.write(
                None, "error", {"what": "breakaway_refused"}
            )
        print(
            "report-shell: warning: job breakaway was refused; "
            "retrying detached launch without breakaway",
            file=sys.stderr,
        )
        options["creationflags"] = NO_BREAKAWAY_FLAGS
        return subprocess.Popen(args, **options)


def launch_server(script, port, data_dir):
    executable = Path(sys.executable).with_name("pythonw.exe")
    if not executable.is_file():
        executable = Path(sys.executable)
    env = dict(os.environ)
    env["RS_DATA_DIR"] = str(Path(data_dir))
    return _detached_popen(
        [str(executable), str(script), "--port", str(port), "serve"],
        ActionLog(data_dir),
        env,
    ).pid


def launch_window(url, data_dir, geometry):
    kind, executable = discover_browser()
    profile = (
        Path(data_dir)
        / ("edge-profile" if kind == "edge" else "chrome-profile")
    ).resolve()
    window = geometry.get("window", geometry) if isinstance(geometry, dict) else {}
    width = int(window.get("width", DEFAULT_WINDOW_WIDTH))
    height = int(window.get("height", DEFAULT_WINDOW_HEIGHT))
    x = int(window.get("x", 0))
    y = int(window.get("y", 0))
    args = [
        str(executable),
        f"--app={url}",
        f"--user-data-dir={profile}",
        f"--window-size={width},{height}",
        f"--window-position={x},{y}",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    process = _detached_popen(args, ActionLog(data_dir))
    identity = BrowserIdentity(
        kind, executable.resolve(), profile, process.pid
    )
    _owned_processes[process.pid] = (identity, process)
    return LaunchResult("app", identity)


def find_window(browser_identity=None, title=None):
    if os.name != "nt":
        return None
    browser_pid = (
        browser_identity.pid
        if isinstance(browser_identity, BrowserIdentity)
        else browser_identity
    )
    user32 = ctypes.windll.user32
    matches = []
    callback_type = ctypes.WINFUNCTYPE(
        ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p
    )

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
        title_match = (
            title
            and text.value == title
            and not text.value.endswith(
                (" - Microsoft Edge", " - Google Chrome")
            )
        )
        if pid_match or title_match:
            matches.append(hwnd)
        return True

    user32.EnumWindows(callback_type(visit), 0)
    return matches[0] if matches else None


def request_attention(browser_identity=None, title=None):
    hwnd = find_window(browser_identity, title)
    if not hwnd:
        return False

    class FlashInfo(ctypes.Structure):
        _fields_ = [
            ("cbSize", ctypes.c_uint),
            ("hwnd", ctypes.c_void_p),
            ("dwFlags", ctypes.c_uint),
            ("uCount", ctypes.c_uint),
            ("dwTimeout", ctypes.c_uint),
        ]

    info = FlashInfo(
        ctypes.sizeof(FlashInfo),
        hwnd,
        0x00000002 | 0x0000000C,
        0,
        0,
    )
    return bool(
        ctypes.windll.user32.FlashWindowEx(ctypes.byref(info))
    )


def focus_window(browser_identity=None, title=None):
    hwnd = find_window(browser_identity, title)
    if hwnd and ctypes.windll.user32.SetForegroundWindow(hwnd):
        return True
    request_attention(browser_identity, title)
    return False


def _win32_apis():
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32.CreateWindowExW.argtypes = [
        wintypes.DWORD,
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        wintypes.DWORD,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        wintypes.HWND,
        wintypes.HMENU,
        wintypes.HINSTANCE,
        wintypes.LPVOID,
    ]
    user32.CreateWindowExW.restype = wintypes.HWND
    user32.DestroyWindow.argtypes = [wintypes.HWND]
    user32.DestroyWindow.restype = wintypes.BOOL
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.OpenClipboard.restype = wintypes.BOOL
    user32.EmptyClipboard.argtypes = []
    user32.EmptyClipboard.restype = wintypes.BOOL
    user32.CloseClipboard.argtypes = []
    user32.CloseClipboard.restype = wintypes.BOOL
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    user32.SetClipboardData.restype = wintypes.HANDLE
    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalUnlock.restype = wintypes.BOOL
    kernel32.GlobalFree.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalFree.restype = wintypes.HGLOBAL
    return user32, kernel32


def write_clipboard(text, tries=5, delay=.05):
    if not hasattr(ctypes, "WinDLL"):
        raise ClipboardBusy("clipboard is available only on Windows")
    user32, kernel32 = _win32_apis()
    hwnd_message = wintypes.HWND(-3)
    hwnd = user32.CreateWindowExW(
        0,
        "STATIC",
        None,
        0,
        0,
        0,
        0,
        0,
        hwnd_message,
        None,
        None,
        None,
    )
    if not hwnd:
        raise OSError(ctypes.get_last_error(), "CreateWindowExW failed")
    try:
        for attempt in range(tries):
            if user32.OpenClipboard(hwnd):
                break
            if attempt + 1 == tries:
                raise ClipboardBusy("clipboard is locked")
            time.sleep(delay)
        try:
            if not user32.EmptyClipboard():
                raise OSError(
                    ctypes.get_last_error(), "EmptyClipboard failed"
                )
            data = (
                text.encode("utf-16-le", errors="surrogatepass")
                + b"\0\0"
            )
            handle = kernel32.GlobalAlloc(0x0002, len(data))
            if not handle:
                raise MemoryError("GlobalAlloc failed")
            pointer = kernel32.GlobalLock(handle)
            if not pointer:
                kernel32.GlobalFree(handle)
                raise OSError(
                    ctypes.get_last_error(), "GlobalLock failed"
                )
            ctypes.memmove(pointer, data, len(data))
            ctypes.set_last_error(0)
            unlocked = kernel32.GlobalUnlock(handle)
            unlock_error = ctypes.get_last_error()
            if not unlocked and unlock_error:
                kernel32.GlobalFree(handle)
                raise OSError(unlock_error, "GlobalUnlock failed")
            if not user32.SetClipboardData(13, handle):
                error = ctypes.get_last_error()
                kernel32.GlobalFree(handle)
                raise OSError(error, "SetClipboardData failed")
        finally:
            user32.CloseClipboard()
    finally:
        if hwnd:
            user32.DestroyWindow(hwnd)


def reveal_file(path):
    subprocess.Popen(
        ["explorer.exe", f'/select,"{Path(path)}"'], shell=False
    )


def final_path_for_handle(handle):
    import msvcrt

    return _final_path_from_os_handle(msvcrt.get_osfhandle(handle.fileno()))


# Template media is opened from a directory the registry already identified.
# CreateFile on a full path still follows intermediate junctions, so each
# component is opened relative to the parent with FILE_OPEN_REPARSE_POINT.
_FILE_LIST_DIRECTORY = 0x0001
_FILE_TRAVERSE = 0x0020
_FILE_READ_ATTRIBUTES = 0x0080
_FILE_READ_DATA = 0x0001
_FILE_READ_EA = 0x0008
_READ_CONTROL = 0x00020000
_SYNCHRONIZE = 0x00100000
_FILE_GENERIC_READ = (
    _READ_CONTROL | _FILE_READ_DATA | _FILE_READ_ATTRIBUTES | _FILE_READ_EA | _SYNCHRONIZE
)
_DIR_ACCESS = _FILE_LIST_DIRECTORY | _FILE_TRAVERSE | _FILE_READ_ATTRIBUTES | _SYNCHRONIZE
_FILE_SHARE_ALL = 0x00000001 | 0x00000002 | 0x00000004
_OPEN_EXISTING = 3
_FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
_FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
_FILE_ATTRIBUTE_REPARSE_POINT = 0x400
_FILE_ATTRIBUTE_NORMAL = 0x80
_FILE_OPEN = 1
_FILE_DIRECTORY_FILE = 0x00000001
_FILE_NON_DIRECTORY_FILE = 0x00000040
_FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020
_FILE_OPEN_REPARSE_POINT = 0x00200000
_OBJ_CASE_INSENSITIVE = 0x00000040
_INVALID_HANDLE = wintypes.HANDLE(-1).value
_kernel_bound = False


class _BY_HANDLE_FILE_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("dwFileAttributes", wintypes.DWORD),
        ("ftCreationTime", wintypes.FILETIME),
        ("ftLastAccessTime", wintypes.FILETIME),
        ("ftLastWriteTime", wintypes.FILETIME),
        ("dwVolumeSerialNumber", wintypes.DWORD),
        ("nFileSizeHigh", wintypes.DWORD),
        ("nFileSizeLow", wintypes.DWORD),
        ("nNumberOfLinks", wintypes.DWORD),
        ("nFileIndexHigh", wintypes.DWORD),
        ("nFileIndexLow", wintypes.DWORD),
    ]


class _UNICODE_STRING(ctypes.Structure):
    _fields_ = [
        ("Length", wintypes.USHORT),
        ("MaximumLength", wintypes.USHORT),
        ("Buffer", wintypes.LPWSTR),
    ]


class _OBJECT_ATTRIBUTES(ctypes.Structure):
    _fields_ = [
        ("Length", wintypes.ULONG),
        ("RootDirectory", wintypes.HANDLE),
        ("ObjectName", ctypes.POINTER(_UNICODE_STRING)),
        ("Attributes", wintypes.ULONG),
        ("SecurityDescriptor", ctypes.c_void_p),
        ("SecurityQualityOfService", ctypes.c_void_p),
    ]


class _IO_STATUS_BLOCK(ctypes.Structure):
    _fields_ = [
        ("Status", ctypes.c_void_p),
        ("Information", ctypes.c_size_t),
    ]


def _kernel():
    global _kernel_bound
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    ntdll = ctypes.WinDLL("ntdll", use_last_error=True)
    if not _kernel_bound:
        kernel32.CreateFileW.argtypes = [
            wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
            wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
        ]
        kernel32.CreateFileW.restype = wintypes.HANDLE
        kernel32.GetFileInformationByHandle.argtypes = [
            wintypes.HANDLE, ctypes.POINTER(_BY_HANDLE_FILE_INFORMATION),
        ]
        kernel32.GetFileInformationByHandle.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        kernel32.GetFinalPathNameByHandleW.argtypes = [
            wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD,
        ]
        kernel32.GetFinalPathNameByHandleW.restype = wintypes.DWORD
        ntdll.NtCreateFile.argtypes = [
            ctypes.POINTER(wintypes.HANDLE), wintypes.DWORD,
            ctypes.POINTER(_OBJECT_ATTRIBUTES), ctypes.POINTER(_IO_STATUS_BLOCK),
            ctypes.c_void_p, wintypes.ULONG, wintypes.ULONG, wintypes.ULONG,
            wintypes.ULONG, ctypes.c_void_p, wintypes.ULONG,
        ]
        ntdll.NtCreateFile.restype = ctypes.c_long
        _kernel_bound = True
    return kernel32, ntdll


def _handle_value(handle):
    value = getattr(handle, "value", handle)
    if not value:
        return 0
    return int(value)


def _valid_handle(handle):
    value = _handle_value(handle)
    return value not in (0, _INVALID_HANDLE)


def _close_handle(handle):
    if not _valid_handle(handle):
        return
    kernel32, _ = _kernel()
    kernel32.CloseHandle(handle)


def _final_path_from_os_handle(os_handle):
    kernel32, _ = _kernel()
    get_final_path = kernel32.GetFinalPathNameByHandleW
    size = get_final_path(os_handle, None, 0, 0)
    if not size:
        raise ctypes.WinError(ctypes.get_last_error())
    buffer = ctypes.create_unicode_buffer(size + 1)
    written = get_final_path(os_handle, buffer, len(buffer), 0)
    if not written or written >= len(buffer):
        raise ctypes.WinError(ctypes.get_last_error())
    value = buffer.value
    if value.startswith("\\\\?\\UNC\\"):
        value = "\\\\" + value[8:]
    elif value.startswith("\\\\?\\"):
        value = value[4:]
    return Path(value)


def _handle_identity(handle):
    kernel32, _ = _kernel()
    info = _BY_HANDLE_FILE_INFORMATION()
    if not kernel32.GetFileInformationByHandle(handle, ctypes.byref(info)):
        raise ctypes.WinError(ctypes.get_last_error())
    file_index = (int(info.nFileIndexHigh) << 32) | int(info.nFileIndexLow)
    reparse = bool(info.dwFileAttributes & _FILE_ATTRIBUTE_REPARSE_POINT)
    return (int(info.dwVolumeSerialNumber), file_index), reparse


def _open_path_nofollow(path, directory):
    kernel32, _ = _kernel()
    flags = _FILE_FLAG_OPEN_REPARSE_POINT
    if directory:
        flags |= _FILE_FLAG_BACKUP_SEMANTICS
    handle = kernel32.CreateFileW(
        str(path),
        _DIR_ACCESS if directory else _FILE_GENERIC_READ,
        _FILE_SHARE_ALL,
        None,
        _OPEN_EXISTING,
        flags,
        None,
    )
    if not _valid_handle(handle):
        raise ctypes.WinError(ctypes.get_last_error())
    return handle


def _component_name(name):
    if (
        not isinstance(name, str)
        or not name
        or name in {".", ".."}
        or "\\" in name
        or "/" in name
        or "\0" in name
    ):
        raise OSError(f"invalid path component: {name!r}")


def _open_relative_nofollow(parent, name, directory):
    _component_name(name)
    _, ntdll = _kernel()
    # Length is a byte count of UTF-16 code units, not Python code points.
    # A non-BMP character is one code point and two UTF-16 units.
    buffer = ctypes.create_unicode_buffer(name)
    encoded = name.encode("utf-16-le", errors="surrogatepass")
    unicode_name = _UNICODE_STRING()
    unicode_name.Length = len(encoded)
    unicode_name.MaximumLength = ctypes.sizeof(buffer)
    unicode_name.Buffer = ctypes.cast(buffer, wintypes.LPWSTR)
    attributes = _OBJECT_ATTRIBUTES()
    attributes.Length = ctypes.sizeof(_OBJECT_ATTRIBUTES)
    attributes.RootDirectory = parent
    attributes.ObjectName = ctypes.pointer(unicode_name)
    attributes.Attributes = _OBJ_CASE_INSENSITIVE
    status_block = _IO_STATUS_BLOCK()
    handle = wintypes.HANDLE()
    options = _FILE_OPEN_REPARSE_POINT | _FILE_SYNCHRONOUS_IO_NONALERT
    options |= _FILE_DIRECTORY_FILE if directory else _FILE_NON_DIRECTORY_FILE
    status = ntdll.NtCreateFile(
        ctypes.byref(handle),
        _DIR_ACCESS if directory else _FILE_GENERIC_READ,
        ctypes.byref(attributes),
        ctypes.byref(status_block),
        None,
        _FILE_ATTRIBUTE_NORMAL,
        _FILE_SHARE_ALL,
        _FILE_OPEN,
        options,
        None,
        0,
    )
    if status < 0 or not _valid_handle(handle):
        _close_handle(handle)
        raise OSError(f"contained open failed for {name!r} ({status:#010x})")
    return handle


def directory_identity(path):
    """Volume serial and file index of a directory, without following a link."""
    handle = _open_path_nofollow(path, directory=True)
    try:
        identity, reparse = _handle_identity(handle)
        if reparse:
            raise ReparseEscape(str(path))
        return identity
    finally:
        _close_handle(handle)


def open_contained(root, parts, expected_identity=None):
    """Open root/parts without following a symlink or junction.

    Returns (binary file, root final path, root identity, file identity).
    The caller closes the file. Identity is (volume serial, file index).
    The same no-follow relative open is what a Linux build would express
    with openat and O_NOFOLLOW; macOS uses that POSIX form.
    """
    parts = tuple(parts)
    for part in parts:
        _component_name(part)
    if not parts:
        raise OSError("contained path is empty")
    root_handle = _open_path_nofollow(root, directory=True)
    file_handle = None
    directories = []
    try:
        root_identity, reparse = _handle_identity(root_handle)
        if reparse:
            raise ReparseEscape(str(root))
        if expected_identity is not None and root_identity != tuple(expected_identity):
            raise PathIdentityError(str(root))
        parent = root_handle
        for index, part in enumerate(parts):
            last = index == len(parts) - 1
            opened = _open_relative_nofollow(parent, part, directory=not last)
            # Own the handle before any fallible query. A failed identity
            # call must still reach the finally block that closes it.
            if last:
                file_handle = opened
            else:
                directories.append(opened)
                parent = opened
            _, child_reparse = _handle_identity(opened)
            if child_reparse:
                raise ReparseEscape(part)
        root_final = _final_path_from_os_handle(_handle_value(root_handle))
        file_identity, _ = _handle_identity(file_handle)
        import msvcrt

        descriptor = msvcrt.open_osfhandle(_handle_value(file_handle), os.O_BINARY)
        file_handle = None
        try:
            opened_file = os.fdopen(descriptor, "rb")
        except Exception:
            os.close(descriptor)
            raise
        return opened_file, root_final, root_identity, file_identity
    finally:
        _close_handle(file_handle)
        for handle in directories:
            _close_handle(handle)
        _close_handle(root_handle)


def query_owned_browser(identity):
    if not isinstance(identity, BrowserIdentity) or identity.pid is None:
        return None
    retained = _owned_processes.get(identity.pid)
    if retained is None or retained[0] != identity:
        return None
    return retained[1].poll() is None


def terminate_owned_browser(identity, timeout):
    owned = query_owned_browser(identity)
    if owned is not True:
        return owned
    process = _owned_processes[identity.pid][1]
    process.terminate()
    try:
        process.wait(timeout=max(0, timeout))
    except subprocess.TimeoutExpired:
        if query_owned_browser(identity) is not True:
            return False
        process.kill()
        process.wait(timeout=max(1, timeout))
    finally:
        _owned_processes.pop(identity.pid, None)
    return True


def install_signal_handlers(server):
    return lambda: None
