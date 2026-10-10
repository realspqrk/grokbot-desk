"""Compatibility imports for callers migrating to :mod:`core.platform`."""
from .platform import ClipboardBusy, utf16_units, write_clipboard


write_text = write_clipboard
