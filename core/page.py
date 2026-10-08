"""Assemble the shell page and inline registered template assets."""
import json
from pathlib import Path

from .jsonutil import dumps, loads
from .product import DISPLAY_NAME

CORE = Path(__file__).resolve().parent


def _json_script(value):
    encoded = dumps(value, ensure_ascii=False, separators=(",", ":"))
    for source, target in (
        ("&", "\\u0026"), ("<", "\\u003c"), (">", "\\u003e"),
        ("\u2028", "\\u2028"), ("\u2029", "\\u2029"),
    ):
        encoded = encoded.replace(source, target)
    return encoded


def build_page(registry, csrf_token, port):
    strings = loads((CORE / "i18n" / "de.json").read_text(encoding="utf-8"))
    strings["app_name"] = DISPLAY_NAME
    strings["window_title_empty"] = f"{DISPLAY_NAME} · {strings['no_runs']}"
    bots = loads((CORE / "bots.json").read_text(encoding="utf-8"))
    platforms_path = CORE / "static" / "platforms.json"
    platforms = loads(platforms_path.read_text(encoding="utf-8")) if platforms_path.exists() else {}
    boot = {
        "csrf": csrf_token,
        "port": port,
        "strings": strings,
        "platforms": platforms,
        "bots": bots,
        "templates": {
            item.id: {
                "version": item.version,
                "components": list(item.components),
                "strings": list(item.strings),
                "title_de": item.title_de,
            }
            for item in registry.values()
        },
    }
    fragments = []
    for template in registry.values():
        html = (template.path / "template.html").read_text(encoding="utf-8")
        css_path = template.path / "template.css"
        js_path = template.path / "template.js"
        fragments.append(f'<template id="rs-tpl-{template.id}">{html}</template>')
        if css_path.exists():
            fragments.append(
                f'<style data-rs-tpl="{template.id}">{css_path.read_text(encoding="utf-8")}</style>'
            )
        if js_path.exists():
            js = js_path.read_text(encoding="utf-8")
            fragments.append(
                f'<script data-rs-tpl="{template.id}">RS._define("{template.id}", '
                f"function (RS, root) {{\n{js}\n}});</script>"
            )
    shell = (CORE / "static" / "shell.html").read_text(encoding="utf-8")
    if (
        shell.count("%%RS_BOOT%%") != 1
        or shell.count("%%RS_TEMPLATES%%") != 1
        or shell.count("%%RS_WINDOW_TITLE%%") != 1
    ):
        raise RuntimeError("shell page markers are invalid")
    return (
        shell.replace("%%RS_BOOT%%", _json_script(boot))
        .replace("%%RS_TEMPLATES%%", "\n".join(fragments))
        .replace("%%RS_WINDOW_TITLE%%", strings["window_title_empty"])
    )
