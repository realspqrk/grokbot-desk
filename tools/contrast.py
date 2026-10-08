#!/usr/bin/env python3
"""Check grokbot-desk design-token foreground/background contrast pairs."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


TOKEN_RE = re.compile(r"(--[\w-]+)\s*:\s*([^;{}]+);")
COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)


def _declarations(block: str) -> dict[str, str]:
    return {name: value.strip() for name, value in TOKEN_RE.findall(block)}


def _resolve(tokens: dict[str, str]) -> dict[str, str]:
    resolved = dict(tokens)
    for _ in range(len(tokens) + 1):
        changed = False
        for name, value in resolved.items():
            match = re.fullmatch(r"var\((--[\w-]+)\)", value)
            if match and match.group(1) in resolved and resolved[match.group(1)] != value:
                resolved[name] = resolved[match.group(1)]
                changed = True
        if not changed:
            break
    return resolved


def parse_token_themes(css: str) -> dict[str, dict[str, str]]:
    clean = COMMENT_RE.sub("", css)
    root_match = re.search(r":root\s*\{([^{}]*)\}", clean)
    if not root_match:
        raise ValueError("tokens.css has no :root block")
    light = _declarations(root_match.group(1))
    dark_matches = re.findall(r"html\[data-theme=[\"']dark[\"']\]\s*\{([^{}]*)\}", clean)
    if not dark_matches:
        raise ValueError('tokens.css has no html[data-theme="dark"] block')
    dark = dict(light)
    dark.update(_declarations(dark_matches[-1]))
    return {"light": _resolve(light), "dark": _resolve(dark)}


def _rgb(value: str) -> tuple[float, float, float]:
    match = re.fullmatch(r"#([0-9a-fA-F]{6})", value.strip())
    if not match:
        raise ValueError(f"expected opaque 6-digit hex colour, got {value!r}")
    number = match.group(1)
    return tuple(int(number[index : index + 2], 16) / 255 for index in (0, 2, 4))


def _luminance(value: str) -> float:
    channels = [
        channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4
        for channel in _rgb(value)
    ]
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]


def contrast_ratio(foreground: str, background: str) -> float:
    first, second = sorted((_luminance(foreground), _luminance(background)), reverse=True)
    return (first + 0.05) / (second + 0.05)


def evaluate_pairs(themes: dict[str, dict[str, str]], pairs: list[dict]) -> dict:
    if not isinstance(pairs, list) or not pairs:
        return {
            "ok": False,
            "error": "contrast contract has no pairs",
            "passed": 0,
            "total": 0,
            "cases": [],
        }
    cases = []
    for theme_name in ("light", "dark"):
        tokens = themes.get(theme_name, {})
        for pair in pairs:
            case = {
                "theme": theme_name,
                "fg": pair.get("fg"),
                "bg": pair.get("bg"),
                "min": pair.get("min"),
                "use": pair.get("use", ""),
            }
            missing = next(
                (token for token in (case["fg"], case["bg"]) if token not in tokens),
                None,
            )
            if missing:
                case.update({"pass": False, "error": f"missing token {missing}"})
            else:
                try:
                    ratio = contrast_ratio(tokens[case["fg"]], tokens[case["bg"]])
                    case.update(
                        {
                            "foreground": tokens[case["fg"]],
                            "background": tokens[case["bg"]],
                            "ratio": ratio,
                            "pass": ratio + 1e-12 >= float(case["min"]),
                        }
                    )
                except (TypeError, ValueError) as error:
                    case.update({"pass": False, "error": str(error)})
            cases.append(case)
    passed = sum(case["pass"] for case in cases)
    return {"ok": passed == len(cases), "passed": passed, "total": len(cases), "cases": cases}


def main(argv=None) -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tokens", type=Path, default=root / "core" / "static" / "tokens.css")
    parser.add_argument(
        "--pairs", type=Path, default=root / "core" / "static" / "contrast-pairs.json"
    )
    args = parser.parse_args(argv)
    try:
        themes = parse_token_themes(args.tokens.read_text(encoding="utf-8"))
        contract = json.loads(args.pairs.read_text(encoding="utf-8"))
        result = evaluate_pairs(themes, contract["pairs"])
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        result = {"ok": False, "error": str(error), "passed": 0, "total": 0, "cases": []}
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
