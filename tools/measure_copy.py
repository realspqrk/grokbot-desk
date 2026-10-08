#!/usr/bin/env python3
"""Measure C5 clipboard byte equality and restore the previous clipboard text."""
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core.clipboard import write_text


def _expected_copy_count():
    total = 0
    for manifest in ROOT.glob("templates/*/*/template.json"):
        expect_dir = manifest.parent / "fixtures" / "expect"
        for expect_path in expect_dir.glob("*.json"):
            value = json.loads(expect_path.read_text(encoding="utf-8"))
            if isinstance(value, dict):
                copies = value.get("copies", {})
                if not isinstance(copies, dict):
                    raise ValueError(f"{expect_path}: copies must be an object")
                total += len(copies)
    return total


def _clipboard():
    result = subprocess.run(
        ["py", "-3", str(ROOT / "tools" / "clipread.py")],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    try:
        snapshot = json.loads(result.stdout)
    except json.JSONDecodeError:
        snapshot = {"available": False, "text": None, "error": result.stderr or result.stdout}
    snapshot["ok"] = result.returncode == 0 and not snapshot.get("error")
    if not snapshot["ok"]:
        snapshot["error"] = (
            snapshot.get("error") or result.stderr.strip() or
            f"clipread.py exited {result.returncode}"
        )
    return snapshot


def _snapshot_metadata(snapshot):
    metadata = {
        "ok": bool(snapshot.get("ok")),
        "available": bool(snapshot.get("available")),
        "error": snapshot.get("error"),
    }
    text = snapshot.get("text")
    if isinstance(text, str):
        metadata["length"] = len(text)
        metadata["sha256"] = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return metadata


def main():
    try:
        expected_total = _expected_copy_count()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(json.dumps({
            "ok": False,
            "error": f"cannot count copy cases: {error}",
            "passed": 0,
            "total": 0,
        }, ensure_ascii=False, separators=(",", ":")))
        return 1
    if expected_total < 20:
        print(json.dumps({
            "ok": False,
            "error": f"copy measurement requires at least 20 cases, found {expected_total}",
            "passed": 0,
            "total": expected_total,
            "clipboard_snapshot": {"ok": False, "skipped": True},
            "clipboard_restore": {
                "had_text": False,
                "required": False,
                "restored": False,
                "error": None,
            },
        }, ensure_ascii=False, separators=(",", ":")))
        return 1
    before = _clipboard()
    if not before.get("ok"):
        measured = {
            "ok": False,
            "error": before.get("error") or "clipboard snapshot failed",
            "passed": 0,
            "total": 0,
            "clipboard_snapshot": _snapshot_metadata(before),
            "clipboard_restore": {
                "had_text": False,
                "required": False,
                "restored": False,
                "error": None,
            },
        }
        print(json.dumps(measured, ensure_ascii=False, separators=(",", ":")))
        return 1
    environment = dict(os.environ)
    environment["RS_ALLOW_CLIPBOARD"] = "1"
    measured = {"ok": False, "error": "copy measurement did not run", "passed": 0, "total": 0}
    try:
        try:
            result = subprocess.run(
                ["node", str(ROOT / "tools" / "e2e.mjs"), "copy", "--all"],
                cwd=ROOT,
                env=environment,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=300,
            )
            try:
                measured = json.loads(result.stdout.strip().splitlines()[-1])
            except (IndexError, json.JSONDecodeError):
                measured = {"ok": False, "error": result.stderr or result.stdout, "passed": 0, "total": 0}
            if result.returncode and measured.get("ok"):
                measured.update(ok=False, error=result.stderr or f"e2e exited {result.returncode}")
        except (OSError, subprocess.TimeoutExpired) as error:
            measured["error"] = str(error)
    finally:
        restored = False
        restore_error = None
        restore_required = before.get("available") and isinstance(before.get("text"), str)
        if restore_required:
            try:
                write_text(before["text"])
                restored = True
            except (OSError, RuntimeError) as error:
                restore_error = str(error)
    measured["clipboard_restore"] = {
        "had_text": bool(before.get("available")),
        "required": bool(restore_required),
        "restored": restored,
        "error": restore_error,
    }
    measured["clipboard_snapshot"] = _snapshot_metadata(before)
    if restore_required and not restored:
        measured["ok"] = False
    print(json.dumps(measured, ensure_ascii=False, separators=(",", ":")))
    return 0 if measured.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
