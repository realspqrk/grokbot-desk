"""CF_UNICODETEXT clipboard writer using a message-only owner window."""
import ctypes
import time
from ctypes import wintypes


class ClipboardBusy(RuntimeError):
    pass


def utf16_units(text):
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2


def _win32_apis():
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32.CreateWindowExW.argtypes = [
        wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.HWND,
        wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID,
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


def write_text(text, tries=5, delay=.05):
    if not hasattr(ctypes, "WinDLL"):
        raise ClipboardBusy("clipboard is available only on Windows")
    user32, kernel32 = _win32_apis()
    hwnd_message = wintypes.HWND(-3)
    hwnd = user32.CreateWindowExW(0, "STATIC", None, 0, 0, 0, 0, 0, hwnd_message, None, None, None)
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
                raise OSError(ctypes.get_last_error(), "EmptyClipboard failed")
            data = text.encode("utf-16-le", errors="surrogatepass") + b"\0\0"
            handle = kernel32.GlobalAlloc(0x0002, len(data))
            if not handle:
                raise MemoryError("GlobalAlloc failed")
            pointer = kernel32.GlobalLock(handle)
            if not pointer:
                kernel32.GlobalFree(handle)
                raise OSError(ctypes.get_last_error(), "GlobalLock failed")
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
