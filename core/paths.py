"""Repository and writable data-directory paths."""
import json
import os
from pathlib import Path

from .jsonutil import loads
from .platform import default_data_dir
from .platform_types import DEFAULT_WINDOW_HEIGHT, DEFAULT_WINDOW_WIDTH
from .product import PRODUCT_NAME

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PORT = 18742


def data_dir():
    return default_data_dir(PRODUCT_NAME)


LEGACY_NAME = "spqrk-report-shell"

MIGRATE_ADVICE = (
    "this is the older data folder; run `python report_shell.py migrate` "
    "while the desk is closed to move it to the new name"
)


def _same_path(a, b):
    try:
        a, b = Path(a).resolve(), Path(b).resolve()
    except OSError:
        a, b = Path(a), Path(b)
    return os.path.normcase(str(a)) == os.path.normcase(str(b))


def is_legacy_location(base):
    """base is the older Windows folder itself (spqrk-report-shell under
    %LOCALAPPDATA%), not just any folder of that name."""
    local = os.environ.get("LOCALAPPDATA")
    return bool(local) and _same_path(base, Path(local) / LEGACY_NAME)


def is_default_legacy(base):
    """base is the older Windows folder, in use by default (RS_DATA_DIR
    unset). Only such a folder is followed, redirected or named for migrate."""
    return not os.environ.get("RS_DATA_DIR") and is_legacy_location(base)


def migration_advice(base):
    """The advice to run migrate, when base is the older Windows folder in
    use by default (never for RS_DATA_DIR)."""
    return MIGRATE_ADVICE if is_default_legacy(base) else None


def legacy_gone(base):
    """True for the older Windows folder after `migrate` moved it away. It
    counts only while it still holds runs/: a stray log or result written
    there after the move does not bring it back. Location only, so a server
    spawned for that folder (RS_DATA_DIR set to it) is caught too."""
    base = Path(base)
    return is_legacy_location(base) and not (base / "runs").is_dir()


def follow_migration(base):
    """The folder a default legacy base was migrated to while a command ran,
    else base unchanged. RS_DATA_DIR is never redirected."""
    base = Path(base)
    if not is_default_legacy(base) or not legacy_gone(base):
        return base
    moved = base.with_name(PRODUCT_NAME)
    return moved if moved.is_dir() else base


def data_dir_report(base=None):
    """The data dir in use, where it came from, and any other candidate that
    holds data (a legacy folder that is not in use, for example)."""
    base = Path(base or data_dir())
    if os.environ.get("RS_DATA_DIR"):
        source = "RS_DATA_DIR"
    elif is_legacy_location(base):
        source = "legacy"
    else:
        source = "default"
    others = []
    for candidate in legacy_data_dirs():
        try:
            if candidate.resolve() != base.resolve() and (candidate / "results").is_dir():
                others.append(str(candidate))
        except OSError:
            continue
    report = {
        "data_dir": str(base),
        "source": source,
        "runs": str(base / "runs"),
        "results": str(base / "results"),
        "log": str(base / "log"),
        "config": str(base / "config.json"),
    }
    if others:
        report["unused_data_dirs"] = others
    advice = migration_advice(base)
    if advice:
        report["warning"] = advice
    return report


def legacy_data_dirs():
    """Folders an older install may have used (Windows only)."""
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        return []
    return [Path(local) / LEGACY_NAME, Path(local) / PRODUCT_NAME]


def ensure_layout(base=None):
    """Create the data folder and its subfolders; returns the folder used.

    The older Windows folder is never created again: once `migrate` moved
    it, the new folder next to it is used instead, unless RS_DATA_DIR names
    it (a server spawned for it); then it is returned as is, and that
    server refuses to start. Any other folder, whatever its name, is used
    as given."""
    base = Path(base or data_dir())
    if is_legacy_location(base):
        try:
            if not legacy_gone(base):
                # no parents=True: a folder moved away meanwhile stays gone
                for name in ("runs", "results", "log", "media"):
                    (base / name).mkdir(exist_ok=True)
                return base
        except FileNotFoundError:
            pass
        if os.environ.get("RS_DATA_DIR"):
            return base
        base = base.with_name(PRODUCT_NAME)
    base.mkdir(mode=0o700, parents=True, exist_ok=True)
    for name in ("runs", "results", "log", "media"):
        (base / name).mkdir(exist_ok=True)
    return base


def default_config(base=None):
    base = Path(base or data_dir())
    user = Path(os.environ.get("USERPROFILE", Path.home()))
    return {
        "port": DEFAULT_PORT,
        "window": {"x": 0, "y": 0, "width": DEFAULT_WINDOW_WIDTH, "height": DEFAULT_WINDOW_HEIGHT},
        "media_roots": [
            str(user / "Downloads"),
            str(base / "media"),
        ],
        "webhook": {"enabled": False, "allow_prefixes": []},
    }


def load_config(base=None):
    base = Path(base or data_dir())
    result = default_config(base)
    path = base / "config.json"
    if not path.exists():
        return result
    loaded = loads(path.read_text(encoding="utf-8"))
    if not isinstance(loaded, dict):
        raise ValueError("config.json must contain an object")
    result.update(loaded)
    if isinstance(loaded.get("window"), dict):
        result["window"] = default_config(base)["window"] | loaded["window"]
    if isinstance(loaded.get("webhook"), dict):
        result["webhook"] = default_config(base)["webhook"] | loaded["webhook"]
    return result


def selected_port(cli_port=None, config=None):
    return int(cli_port if cli_port is not None else (config or load_config())["port"])
