"""Single import-time selector for the Windows or Darwin native backend."""
import sys

from .platform_types import (
    BrowserIdentity,
    BrowserLaunchError,
    BrowserNotFound,
    ClipboardBusy,
    ClipboardError,
    ClipboardTimeout,
    ClipboardUnavailable,
    LaunchResult,
    PathIdentityError,
    ReparseEscape,
)


if sys.platform == "darwin":
    from . import platform_darwin as _backend
elif sys.platform == "win32":
    from . import platform_windows as _backend
else:
    raise RuntimeError(f"unsupported platform: {sys.platform}")


BACKEND_NAME = "darwin" if sys.platform == "darwin" else "windows"
ALLOW_REUSE_ADDRESS = _backend.ALLOW_REUSE_ADDRESS
default_data_dir = _backend.default_data_dir
launch_server = _backend.launch_server
launch_window = _backend.launch_window
write_clipboard = _backend.write_clipboard
request_attention = _backend.request_attention
focus_window = _backend.focus_window
reveal_file = _backend.reveal_file
final_path_for_handle = _backend.final_path_for_handle
directory_identity = _backend.directory_identity
open_contained = _backend.open_contained
query_owned_browser = _backend.query_owned_browser
terminate_owned_browser = _backend.terminate_owned_browser
install_signal_handlers = _backend.install_signal_handlers


def utf16_units(text):
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2
