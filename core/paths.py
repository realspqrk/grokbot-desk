"""Repository and writable data-directory paths."""
import json
import os
import sys
from pathlib import Path

from .jsonutil import loads
from .product import PRODUCT_NAME

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PORT = 18742


def data_dir():
    override = os.environ.get("RS_DATA_DIR")
    if override:
        return Path(override).resolve()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / PRODUCT_NAME
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        raise RuntimeError("LOCALAPPDATA is not set")
    local = Path(local)
    current = local / PRODUCT_NAME
    legacy = local / "spqrk-report-shell"
    return legacy if not current.exists() and legacy.is_dir() else current


def ensure_layout(base=None):
    base = Path(base or data_dir())
    base.mkdir(parents=True, exist_ok=True)
    for name in ("runs", "results", "log", "media"):
        (base / name).mkdir(exist_ok=True)
    return base


def default_config(base=None):
    base = Path(base or data_dir())
    user = Path(os.environ.get("USERPROFILE", Path.home()))
    return {
        "port": DEFAULT_PORT,
        "window": {"x": 0, "y": 0, "width": 1500, "height": 1000},
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
