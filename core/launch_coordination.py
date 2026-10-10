"""Cross-process coordination for native browser window launches."""
import json
import os
import secrets
import time
from pathlib import Path


def launch_lock_path(base):
    return Path(base) / "window-launch.lock"


def pending_launch_path(base):
    return Path(base) / "browser-launch.pending"


def try_acquire_launch_lock(base):
    path = launch_lock_path(base)
    try:
        return os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except PermissionError:
        # Windows: the holder is deleting the lock right now; still held
        return None
    except FileExistsError:
        try:
            if time.time() - path.stat().st_mtime <= 10:
                return None
            path.unlink()
            return os.open(
                path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600
            )
        except (FileExistsError, FileNotFoundError, OSError):
            return None


def acquire_launch_lock(base, timeout=5):
    deadline = time.monotonic() + timeout
    while True:
        descriptor = try_acquire_launch_lock(base)
        if descriptor is not None:
            return descriptor
        if time.monotonic() >= deadline:
            return None
        time.sleep(.01)


def release_launch_lock(base, descriptor):
    os.close(descriptor)
    deadline = time.monotonic() + 1
    while True:
        try:
            launch_lock_path(base).unlink()
            return
        except FileNotFoundError:
            return
        except PermissionError:
            # Windows: another process is looking at the lock (stat) right
            # now; it is gone a moment later
            if time.monotonic() >= deadline:
                raise
            time.sleep(.01)


def _read_pending(base):
    path = pending_launch_path(base)
    try:
        raw = path.read_text(encoding="ascii")
    except (FileNotFoundError, OSError):
        return None
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        try:
            return None, float(raw)
        except ValueError:
            return None
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("generation"), str)
        or not value["generation"]
        or not isinstance(value.get("deadline"), (int, float))
    ):
        return None
    return value["generation"], float(value["deadline"])


def pending_launch_generation(base):
    pending = _read_pending(base)
    if pending is None or pending[1] <= time.time():
        return None
    return pending[0]


def launch_is_pending(base, legacy_state=None):
    pending = _read_pending(base)
    now = time.time()
    if pending is not None and pending[1] > now:
        return True
    if pending is not None:
        try:
            pending_launch_path(base).unlink()
        except FileNotFoundError:
            pass
    return (legacy_state or {}).get("browser_launch_pending_until", 0) > now


def mark_launch_pending(base):
    generation = secrets.token_hex(16)
    path = pending_launch_path(base)
    temporary = path.with_suffix(".pending.tmp")
    temporary.write_text(
        json.dumps(
            {"generation": generation, "deadline": time.time() + 5},
            separators=(",", ":"),
        ),
        encoding="ascii",
    )
    os.replace(temporary, path)
    return generation


def clear_launch_pending(base, generation):
    pending = _read_pending(base)
    if pending is None or pending[0] != generation:
        return False
    try:
        pending_launch_path(base).unlink()
    except FileNotFoundError:
        return False
    except PermissionError:
        # Windows: a page's stream is reading it right now; a later clear
        # (or its 5 s deadline) ends it
        return False
    return True


def clear_launch_pending_coordinated(base, generation):
    if generation is None:
        return False
    descriptor = acquire_launch_lock(base)
    if descriptor is None:
        return False
    try:
        return clear_launch_pending(base, generation)
    finally:
        release_launch_lock(base, descriptor)
