import json

import pytest

from tools.contrast import contrast_ratio, evaluate_pairs, parse_token_themes


def test_contrast_ratio_uses_wcag_relative_luminance():
    assert contrast_ratio("#000000", "#ffffff") == pytest.approx(21.0)
    assert contrast_ratio("#777777", "#ffffff") == pytest.approx(4.478, abs=0.001)


def test_parse_token_themes_resolves_root_and_explicit_dark_values():
    css = """
    :root {
      --paper: #ffffff;
      --ink: #111111;
      --same: #123456;
    }
    @media (prefers-color-scheme: dark) {
      html:not([data-theme="light"]) {
        --paper: #111111;
        --ink: #eeeeee;
      }
    }
    html[data-theme="dark"] {
      --paper: #111111;
      --ink: #eeeeee;
    }
    """

    themes = parse_token_themes(css)

    assert themes["light"]["--same"] == "#123456"
    assert themes["dark"]["--same"] == "#123456"
    assert themes["dark"]["--ink"] == "#eeeeee"


def test_evaluate_pairs_reports_missing_tokens_and_failed_ratios():
    themes = {
        "light": {"--fg": "#777777", "--bg": "#ffffff"},
        "dark": {"--fg": "#eeeeee", "--bg": "#111111"},
    }
    pairs = [
        {"fg": "--fg", "bg": "--bg", "min": 4.5, "use": "body"},
        {"fg": "--missing", "bg": "--bg", "min": 3.0, "use": "focus"},
    ]

    result = evaluate_pairs(themes, pairs)

    assert result["total"] == 4
    assert result["passed"] == 1
    assert result["ok"] is False
    failures = [case for case in result["cases"] if not case["pass"]]
    assert failures[0]["theme"] == "light"
    assert failures[0]["ratio"] == pytest.approx(4.478, abs=0.001)
    assert failures[1]["error"] == "missing token --missing"


def test_repository_contrast_contract_is_machine_readable(tmp_path):
    tokens = tmp_path / "tokens.css"
    pairs = tmp_path / "pairs.json"
    tokens.write_text(
        ":root { --fg: #000000; --bg: #ffffff; }\n"
        'html[data-theme="dark"] { --fg: #ffffff; --bg: #000000; }',
        encoding="utf-8",
    )
    pairs.write_text(json.dumps({"pairs": [{"fg": "--fg", "bg": "--bg", "min": 4.5}]}), encoding="utf-8")

    themes = parse_token_themes(tokens.read_text(encoding="utf-8"))
    result = evaluate_pairs(themes, json.loads(pairs.read_text(encoding="utf-8"))["pairs"])

    assert result["ok"] is True
    assert result["passed"] == result["total"] == 2


def test_finding_11_empty_contrast_contract_fails():
    themes = {
        "light": {"--fg": "#000000", "--bg": "#ffffff"},
        "dark": {"--fg": "#ffffff", "--bg": "#000000"},
    }

    result = evaluate_pairs(themes, [])

    assert result["ok"] is False
    assert result["total"] == 0
    assert result["error"] == "contrast contract has no pairs"
