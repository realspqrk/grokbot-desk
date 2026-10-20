"""Assemble the shell page with its boot data."""
import json
import os
from pathlib import Path

from .identity import SHIPPED_REGISTRY, display_names, load_registry, shape_set
from .jsonutil import dumps, loads
from .product import DISPLAY_NAME
from .timeutil import effective_zone_name

CORE = Path(__file__).resolve().parent
LANGS = ("de", "en")


def string_table():
    """German by default; RS_LANG=en selects the English table (screenshots, demos)."""
    lang = os.environ.get("RS_LANG", "de")
    return CORE / "i18n" / f"{lang if lang in LANGS else 'de'}.json"


def _json_script(value):
    encoded = dumps(value, ensure_ascii=False, separators=(",", ":"))
    for source, target in (
        ("&", "\\u0026"), ("<", "\\u003c"), (">", "\\u003e"),
        ("\u2028", "\\u2028"), ("\u2029", "\\u2029"),
    ):
        encoded = encoded.replace(source, target)
    return encoded


def build_page(csrf_token, port, desk=""):
    table = string_table()
    strings = loads(table.read_text(encoding="utf-8"))
    strings["app_name"] = DISPLAY_NAME
    strings["window_title_empty"] = f"{DISPLAY_NAME} · {strings['no_runs']}"
    bots = display_names(load_registry(SHIPPED_REGISTRY, "shipped")[0])
    platforms_path = CORE / "static" / "platforms.json"
    platforms = loads(platforms_path.read_text(encoding="utf-8")) if platforms_path.exists() else {}
    boot = {
        "csrf": csrf_token,
        # the desk run that served this page (not a secret): /events names it
        # so a desk started later tells this page to reload
        "desk": desk,
        "port": port,
        "lang": table.stem,
        "tz": effective_zone_name(),
        "strings": strings,
        "platforms": platforms,
        "bots": bots,
        "avatar_shapes": shape_set(),
    }
    shell = (CORE / "static" / "shell.html").read_text(encoding="utf-8")
    if shell.count("%%RS_BOOT%%") != 1 or shell.count("%%RS_WINDOW_TITLE%%") != 1:
        raise RuntimeError("shell page markers are invalid")
    return (
        shell.replace("%%RS_BOOT%%", _json_script(boot))
        .replace("%%RS_WINDOW_TITLE%%", strings["window_title_empty"])
    )
