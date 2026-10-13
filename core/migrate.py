"""The explicit move of the old Windows data folder (`migrate`), and the
server lock that keeps a running desk and a migration apart.

A server holds `server.lock` in its data folder for its whole life (an OS
file lock, released when the process ends). `migrate` first writes
`migrate.pending`, then checks the lock; a starting server first takes the
lock, then checks for `migrate.pending`. Whichever comes second sees the
other, so a migration never moves a folder that a server has started to use.
"""
import os
import socket
import sys
import time
from pathlib import Path

from .jsonutil import dumps, loads
from .launch_coordination import launch_is_pending
from .paths import LEGACY_NAME
from .product import PRODUCT_NAME

LOCK_NAME = "server.lock"
PENDING_NAME = "migrate.pending"
# A migration takes seconds. An older marker is left over from a crash.
PENDING_STALE_S = 120
# Files a desk writes for itself and rewrites on its next start.
HOUSEKEEPING = {LOCK_NAME, "state.json", PENDING_NAME}


class DataDirBusy(RuntimeError):
    """A server must not start in this data folder now."""


class MigrationRefused(RuntimeError):
    def __init__(self, message, code):
        super().__init__(message)
        self.code = code


def _lock_fd(fd):
    if sys.platform == "win32":
        import msvcrt

        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    else:
        import fcntl

        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)


def hold_server_lock(base):
    """Take this data folder's server lock for the life of the process.

    Returns the open descriptor, or None when another process holds it (a
    second server on another port; that one already keeps a migration out)."""
    fd = os.open(Path(base) / LOCK_NAME, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        _lock_fd(fd)
    except OSError:
        os.close(fd)
        return None
    return fd


def server_lock_held(base):
    path = Path(base) / LOCK_NAME
    if not path.exists():
        return False
    try:
        fd = os.open(path, os.O_RDWR)
    except OSError:
        return True
    try:
        _lock_fd(fd)
    except OSError:
        return True
    finally:
        os.close(fd)
    return False


def migration_pending(base):
    try:
        return time.time() - (Path(base) / PENDING_NAME).stat().st_mtime < PENDING_STALE_S
    except OSError:
        return False


def _port_answers(base):
    try:
        port = int(loads((Path(base) / "state.json").read_text(encoding="utf-8")).get("port"))
        with socket.create_connection(("127.0.0.1", port), timeout=.3):
            return True
    except (OSError, ValueError, TypeError, AttributeError):
        return False


def desk_busy(base):
    """A server runs, starts or opens its window in this folder."""
    base = Path(base)
    return base.is_dir() and (
        server_lock_held(base) or _port_answers(base) or launch_is_pending(base)
    )


def _first_file(base):
    for folder, _, files in os.walk(base):
        for name in files:
            path = Path(folder) / name
            if path.parent == Path(base) and name in HOUSEKEEPING:
                continue
            return path
    return None


def _moved(value, old, new):
    if isinstance(value, str):
        folded, root = os.path.normcase(value), os.path.normcase(old)
        if folded == root or folded.startswith(root.rstrip("\\/") + os.sep):
            return new + value[len(old):]
        return value
    if isinstance(value, list):
        return [_moved(item, old, new) for item in value]
    if isinstance(value, dict):
        return {key: _moved(item, old, new) for key, item in value.items()}
    return value


def _rewrite_json(path, old, new, select=None):
    """Point absolute paths under old to new in one JSON file, atomically.
    With select, only that top-level list changes. Returns the original
    bytes when the file changed (to put back), else None."""
    if not path.is_file():
        return None
    original = path.read_bytes()
    try:
        value = loads(original.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        return None  # unreadable now, unreadable after the move: leave it
    if select is not None and not (
        isinstance(value, dict) and isinstance(value.get(select), list)
    ):
        return None
    changed = value[select] if select is not None else value
    for prefix in old:
        changed = _moved(changed, prefix, new)
    if select is not None:
        if changed == value[select]:
            return None
        text = dumps(dict(value, **{select: changed}), ensure_ascii=False, indent=2)
    else:
        if changed == value:
            return None
        # the run store's own format (core/runs.py RunStore._save)
        text = dumps(changed, ensure_ascii=False, separators=(",", ":"))
    _replace(path, (text + "\n").encode("utf-8"))
    return original


def _rewrite_references(legacy, current):
    """Point run records (media paths, roots) and config.json media_roots
    under legacy to current, inside legacy, one atomic file at a time.
    Returns {path: original bytes} of every file changed. On an error the
    files changed so far are put back before it is raised."""
    old = [str(legacy)]
    try:
        resolved = str(legacy.resolve())
    except OSError:
        resolved = old[0]
    if os.path.normcase(resolved) != os.path.normcase(old[0]):
        old.append(resolved)
    originals = {}
    try:
        for path in sorted((legacy / "runs").glob("*.json")):
            before = _rewrite_json(path, old, str(current))
            if before is not None:
                originals[path] = before
        config = legacy / "config.json"
        before = _rewrite_json(config, old, str(current), select="media_roots")
        if before is not None:
            originals[config] = before
    except BaseException:
        _restore(originals)
        raise
    return originals


def _restore(originals):
    for path, data in originals.items():
        _replace(path, data)


def _replace(path, data):
    temporary = path.with_name(path.name + ".migrate.tmp")
    temporary.write_bytes(data)
    os.replace(temporary, path)


def open_runs(base):
    """Run ids in base that have no result yet."""
    base = Path(base)
    return sorted(
        path.stem for path in (base / "runs").glob("*.json")
        if not (base / "results" / path.name).exists()
    )


def migrate(local):
    """Move local/<legacy> to local/<product>.

    Raises MigrationRefused (nothing changed) when a desk runs or starts in
    either folder, another migrate runs, a run in the old folder is still
    open, or the new folder already holds files. Paths under the old folder
    in decided run records (media paths and roots) and in config.json
    media_roots are rewritten inside the old folder before the move, and
    every rewritten file is put back when the move fails."""
    local = Path(local)
    legacy, current = local / LEGACY_NAME, local / PRODUCT_NAME
    summary = {"from": str(legacy), "to": str(current)}
    if not legacy.is_dir():
        return {"migrated": False, "reason": "nothing to migrate", **summary}
    stray = _first_file(current) if current.exists() else None
    if stray is not None:
        raise MigrationRefused(
            f"{current} already holds files ({stray}); move them away or keep using the old folder",
            7,
        )
    marker = legacy / PENDING_NAME
    if migration_pending(legacy):
        raise MigrationRefused("another migrate is running", 4)
    marker.write_text(str(os.getpid()), encoding="utf-8")
    try:
        if desk_busy(legacy) or desk_busy(current):
            raise MigrationRefused(
                "the desk is running; close it (python report_shell.py stop) and run migrate again",
                4,
            )
        still_open = open_runs(legacy)
        if still_open:
            raise MigrationRefused(
                f"{len(still_open)} desk(s) in the old folder are still open; "
                "decide or discard open desks first, close the desk, then run migrate again",
                4,
            )
        originals = _rewrite_references(legacy, current)
        emptied = []
        try:
            if current.exists():
                for name in HOUSEKEEPING:
                    if (current / name).is_file():
                        os.remove(current / name)
                for folder, _, _ in os.walk(current, topdown=False):
                    os.rmdir(folder)
                    emptied.append(folder)
            os.replace(legacy, current)
        except BaseException:
            for folder in reversed(emptied):
                os.makedirs(folder, exist_ok=True)
            _restore(originals)
            raise
        marker = current / PENDING_NAME
        config = legacy / "config.json"
        return {
            "migrated": True,
            **summary,
            "config_rewritten": config in originals,
            "runs_rewritten": len(originals) - (config in originals),
        }
    finally:
        try:
            marker.unlink()
        except OSError:
            pass
