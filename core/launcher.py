"""Compatibility imports for callers migrating to :mod:`core.platform`."""
from .platform import (
    BrowserNotFound,
    focus_window,
    launch_server,
    launch_window,
    request_attention,
)


flash_window = request_attention
