#!/usr/bin/env python3
"""Compatibility command entry point for grokbot-desk."""
import sys

if sys.version_info < (3, 11):
    sys.stderr.write(
        "report-shell: Python 3.11 or later is required (this is "
        f"{sys.version_info[0]}.{sys.version_info[1]}). On macOS, "
        "/usr/bin/python3 is too old: install Python 3.11+ (for example "
        "brew install python@3.12) and run python3.12 report_shell.py, "
        "or use ./report-shell.\n"
    )
    raise SystemExit(1)

from core.cli import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main())
