"""Repository and writable data-directory paths."""
import json
import os
import socket
import sys
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

# What the last migrate_legacy_data_dir call did in this process: None (nothing
# to do), "migrated", "live" (a server still owns the legacy dir) or "failed".
MIGRATION = {"state": None, "warning": None}
_warned = False


def _only_empty_dirs(base):
    return not any(files for _, _, files in os.walk(base))


def _server_owns(base):
    """True when a server recorded in base/state.json still listens."""
    try:
        port = int(loads((base / "state.json").read_text(encoding="utf-8")).get("port"))
        with socket.create_connection(("127.0.0.1", port), timeout=.3):
            return True
    except (OSError, ValueError, TypeError, AttributeError):
        return False


def migrate_legacy_data_dir(local=None):
    """Move the old Windows data folder to the product name, once.

    Runs only when the old folder exists and the new one is missing or holds
    no files. Never while a server still owns the old folder. On any failure
    the old folder stays in use and nothing is lost. RS_DATA_DIR is never
    migrated. Returns and records the outcome in MIGRATION."""
    global _warned
    MIGRATION.update(state=None, warning=None)
    if os.environ.get("RS_DATA_DIR"):
        return MIGRATION
    if local is None:
        if sys.platform != "win32" or not os.environ.get("LOCALAPPDATA"):
            return MIGRATION
        local = os.environ["LOCALAPPDATA"]
    local = Path(local)
    legacy, current = local / LEGACY_NAME, local / PRODUCT_NAME
    try:
        if not legacy.is_dir():
            return MIGRATION
        if current.exists() and not (current.is_dir() and _only_empty_dirs(current)):
            return MIGRATION
        if _server_owns(legacy):
            MIGRATION.update(
                state="live",
                warning="a running server still uses the old data folder; it moves after that server stops",
            )
            return MIGRATION
        if current.exists():
            for folder, _, _ in os.walk(current, topdown=False):
                os.rmdir(folder)
        os.replace(legacy, current)
        MIGRATION["state"] = "migrated"
    except OSError as exc:
        MIGRATION.update(
            state="failed",
            warning=f"could not move the old data folder, still using it: {exc.strerror or exc}",
        )
        if not _warned:
            _warned = True
            print(f"report-shell: {MIGRATION['warning']}", file=sys.stderr)
    return MIGRATION


def data_dir_report(base=None):
    """The data dir in use, where it came from, and any other candidate that
    holds data (a legacy folder that is not in use, for example)."""
    base = Path(base or data_dir())
    if os.environ.get("RS_DATA_DIR"):
        source = "RS_DATA_DIR"
    elif base.name == LEGACY_NAME:
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
    if MIGRATION["state"]:
        report["reason"] = MIGRATION["state"]
        if MIGRATION["warning"]:
            report["warning"] = MIGRATION["warning"]
    return report


def legacy_data_dirs():
    """Folders an older install may have used (Windows only)."""
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        return []
    return [Path(local) / LEGACY_NAME, Path(local) / PRODUCT_NAME]


def ensure_layout(base=None):
    base = Path(base or data_dir())
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
