"""Open an http(s) URL in the host operating system's default browser.

Windows uses os.startfile. macOS uses `/usr/bin/open` with an argument list
and no shell. Other systems use `xdg-open` when it is on PATH, also with
an argument list and no shell.
"""
import os
import shutil
import subprocess
import sys


def open_url(url):
    if sys.platform == "win32":
        from .platform_windows import open_url as open_on_windows

        open_on_windows(url)
        return
    if sys.platform == "darwin":
        from .platform_darwin import open_url as open_on_darwin

        open_on_darwin(url)
        return
    exe = shutil.which("xdg-open")
    if not exe:
        raise OSError("xdg-open is not available")
    subprocess.Popen([exe, str(url)], shell=False)
