"""Append-only JSONL action log."""
import hashlib
import json
import os
from pathlib import Path
from threading import Lock

from .jsonutil import dumps
from .timeutil import iso_now, vienna_now


class ActionLog:
    def __init__(self, data_dir):
        self.folder = Path(data_dir) / "log"
        self.folder.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()

    def path(self):
        return self.folder / f"{vienna_now():%Y-%m-%d}.jsonl"

    def write(self, run_id, event, detail=None):
        if event == "copy" and detail and "text" in detail:
            text = detail["text"]
            detail = {
                "len": len(text),
                "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            }
        line = {
            "ts": iso_now(),
            "run_id": run_id,
            "event": event,
            "detail": detail or {},
        }
        encoded = dumps(line, ensure_ascii=False, separators=(",", ":")) + "\n"
        with self._lock:
            with self.path().open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
        return self.path()
