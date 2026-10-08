"""Atomic immutable result files."""
import json
import os
from pathlib import Path

from .jsonutil import dumps


class ResultExists(FileExistsError):
    pass


def write_result(results_dir, run_id, envelope, before_replace=None):
    folder = Path(results_dir)
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{run_id}.json"
    temporary = folder / f"{run_id}.json.tmp"
    if target.exists():
        raise ResultExists(str(target))
    try:
        temporary.unlink()
    except FileNotFoundError:
        pass
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as handle:
            handle.write(dumps(envelope, ensure_ascii=False, separators=(",", ":")))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        if before_replace:
            before_replace()
        if target.exists():
            raise ResultExists(str(target))
        os.replace(temporary, target)
        return target
    except Exception:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise
