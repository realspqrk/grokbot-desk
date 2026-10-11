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


def data_dir_report(base=None):
    """The data dir in use, where it came from, and any other candidate that
    holds data (a legacy folder that is not in use, for example)."""
    base = Path(base or data_dir())
    if os.environ.get("RS_DATA_DIR"):
        source = "RS_DATA_DIR"
    elif base.name == "spqrk-report-shell":
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
    return report


def legacy_data_dirs():
    """Folders an older install may have used (Windows only)."""
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        return []
    return [Path(local) / "spqrk-report-shell", Path(local) / PRODUCT_NAME]


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
