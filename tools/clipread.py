#!/usr/bin/env python3
"""Read CF_UNICODETEXT without changing the Windows clipboard."""
import ctypes
import json
import sys
import time
from ctypes import wintypes


CF_UNICODETEXT = 13
user32 = None
kernel32 = None


def _initialize():
    global user32, kernel32
    if user32 is not None:
        return
    if not hasattr(ctypes, "WinDLL"):
        raise OSError("CF_UNICODETEXT inspection is available only on Windows")
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.OpenClipboard.restype = wintypes.BOOL
    user32.CloseClipboard.restype = wintypes.BOOL
    user32.IsClipboardFormatAvailable.argtypes = [wintypes.UINT]
    user32.IsClipboardFormatAvailable.restype = wintypes.BOOL
    user32.GetClipboardData.argtypes = [wintypes.UINT]
    user32.GetClipboardData.restype = wintypes.HANDLE
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalUnlock.restype = wintypes.BOOL


def read_text():
    _initialize()
    if not user32.IsClipboardFormatAvailable(CF_UNICODETEXT):
        return None
    for _ in range(10):
        if user32.OpenClipboard(None):
            break
        time.sleep(0.05)
    else:
        raise OSError(ctypes.get_last_error(), "OpenClipboard failed")
    try:
        handle = user32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            raise OSError(ctypes.get_last_error(), "GetClipboardData failed")
        pointer = kernel32.GlobalLock(handle)
        if not pointer:
            raise OSError(ctypes.get_last_error(), "GlobalLock failed")
        try:
            return ctypes.wstring_at(pointer)
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()


def main():
    try:
        text = read_text()
        print(json.dumps(
            {"ok": True, "available": text is not None, "text": text},
            ensure_ascii=False,
        ))
        return 0
    except OSError as error:
        print(json.dumps({
            "ok": False,
            "available": False,
            "text": None,
            "error": str(error),
        }))
        return 1


if __name__ == "__main__":
    sys.exit(main())
