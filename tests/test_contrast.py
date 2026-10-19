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


# ------------------------------------------------- OKLCH tokens and gates --

from pathlib import Path

from tools.contrast import contrast, delta_e_ok, oklab, parse_color, to_hex

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "core" / "static"
THEMES = parse_token_themes((STATIC / "tokens.css").read_text(encoding="utf-8"))
PAIRS = json.loads((STATIC / "contrast-pairs.json").read_text(encoding="utf-8"))["pairs"]
STATUSES = ("ok", "warn", "danger", "info")
CATS = tuple(f"--rs-cat-{index}" for index in range(1, 5))


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("oklch(1 0 0)", "#ffffff"),
        ("oklch(0% 0 0)", "#000000"),
        ("oklch(50% 0 0)", "#636363"),
        ("oklch(0.6279554 0.2576833 29.2338851)", "#ff0000"),
        ("oklch(0.4520137 0.3132143 264.0520206)", "#0000ff"),
        ("oklch(0.8664396 0.2948272 142.4953)", "#00ff00"),
        ("#3B4FD8", "#3b4fd8"),
    ],
)
def test_oklch_parse_matches_reference_vectors(text, expected):
    assert to_hex(parse_color(text)) == expected


def test_out_of_gamut_oklch_keeps_lightness_and_hue_and_drops_chroma():
    rgb = parse_color("oklch(0.7 0.4 145)")
    assert all(0 <= channel <= 1 for channel in rgb)
    assert min(rgb) < 1e-3 or max(rgb) > 1 - 1e-3, "lands on the gamut edge"
    lightness, a, b = oklab(rgb)
    import math
    assert lightness == pytest.approx(0.7, abs=0.005)
    assert math.degrees(math.atan2(b, a)) % 360 == pytest.approx(145, abs=1.5)
    assert 0.1 < math.hypot(a, b) < 0.4


@pytest.mark.parametrize("text", ["oklch(0.5 0.1 1e999)", "oklch(0.5 1e999 20)", "oklch(1e999% 0 0)", "oklch(0.5 0.1)", "oklch(0.5 0.1 20 / 0.5)", "rgb(0,0,0)", "#fff", "oklch(2 0 0)"])
def test_parse_color_rejects_what_it_cannot_check(text):
    with pytest.raises(ValueError):
        parse_color(text)


def test_contrast_reads_oklch_and_hex_alike():
    assert contrast("oklch(1 0 0)", "#000000") == pytest.approx(21.0)
    assert contrast_ratio("oklch(0 0 0)", "#ffffff") == pytest.approx(21.0)


def _repo_pairs(predicate):
    result = evaluate_pairs(THEMES, [pair for pair in PAIRS if predicate(pair)])
    failures = [case for case in result["cases"] if not case["pass"]]
    return result, failures


def _has_pair(fg, bg, minimum):
    return any(p["fg"] == fg and p["bg"] == bg and p["min"] >= minimum for p in PAIRS)


def test_all_text_pairs_wcag_aa_both_themes():
    for status in STATUSES:
        text, tint = f"--rs-status-{status}-text", f"--rs-status-{status}-tint"
        for bg in (tint, "--rs-paper", "--rs-card"):
            assert _has_pair(text, bg, 4.5), (text, bg)
        assert _has_pair("--rs-ink", tint, 4.5), tint
    for fg in ("--rs-ink", "--rs-muted"):
        for bg in ("--rs-paper", "--rs-card", "--rs-raised", "--rs-rail-bg"):
            assert _has_pair(fg, bg, 4.5), (fg, bg)
    result, failures = _repo_pairs(lambda pair: pair["min"] >= 4.5)
    assert result["total"] > 0
    assert failures == []


def test_ui_pairs_3_to_1_both_themes():
    assert all(pair["min"] >= 3.0 for pair in PAIRS), "no pair below the WCAG 1.4.11 floor"
    for fg in [f"--rs-status-{status}" for status in STATUSES] + list(CATS):
        for bg in ("--rs-paper", "--rs-card"):
            assert _has_pair(fg, bg, 3.0), (fg, bg)
    result, failures = _repo_pairs(lambda pair: pair["min"] < 4.5)
    assert result["total"] > 0
    assert failures == []


def test_status_hues_distinct_in_lightness():
    for theme, tokens in THEMES.items():
        colours = {status: oklab(parse_color(tokens[f"--rs-status-{status}"])) for status in STATUSES}
        for index, first in enumerate(STATUSES):
            for second in STATUSES[index + 1:]:
                gap = abs(colours[first][0] - colours[second][0])
                assert gap >= 0.04, (theme, first, second, round(gap, 3))


def test_cat_palette_pairwise_distinct():
    for theme, tokens in THEMES.items():
        for index, first in enumerate(CATS):
            for second in CATS[index + 1:]:
                distance = delta_e_ok(parse_color(tokens[first]), parse_color(tokens[second]))
                assert distance >= 0.1, (theme, first, second, round(distance, 3))


def test_dark_theme_is_soft_not_black_and_lifts_by_lightness():
    dark = {name: oklab(parse_color(value))[0] for name, value in THEMES["dark"].items()
            if name in ("--rs-paper", "--rs-card", "--rs-raised", "--rs-ink", "--rs-muted")}
    assert dark["--rs-paper"] == pytest.approx(0.20, abs=0.01)
    assert dark["--rs-paper"] < dark["--rs-card"] < dark["--rs-raised"]
    assert dark["--rs-ink"] == pytest.approx(0.94, abs=0.015)
    assert dark["--rs-muted"] == pytest.approx(0.75, abs=0.03)


def test_desk_oklch_tokens_sit_inside_srgb():
    # browsers and tools/contrast.py gamut-map the same way only inside sRGB
    from tools.contrast import in_gamut
    for theme, tokens in THEMES.items():
        for name, value in tokens.items():
            if value.startswith("oklch("):
                assert in_gamut(value), (theme, name, value)


@pytest.mark.parametrize("bad", [float("nan"), float("inf")])
def test_contrast_gate_fails_a_nonfinite_ratio(monkeypatch, bad):
    import tools.contrast as module
    monkeypatch.setattr(module, "contrast", lambda first, second: bad)
    themes = {"light": {"--fg": "#000000", "--bg": "#ffffff"}, "dark": {"--fg": "#ffffff", "--bg": "#000000"}}
    result = evaluate_pairs(themes, [{"fg": "--fg", "bg": "--bg", "min": 4.5}])
    assert result["ok"] is False and result["passed"] == 0
