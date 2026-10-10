"""P8c shape avatars: core shape set, enum validation, precedence, accent seed."""
import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from core import identity as ident
from core.envelope import validate_payload
from test_identity import PNG_1PX, data_url, get, payload, resolve, server, starter_data  # noqa: F401


ROOT = Path(__file__).resolve().parents[1]
SHAPES_JSON = json.loads((ROOT / "core/static/avatar-shapes.json").read_text(encoding="utf-8"))


# ------------------------------------------------------------ shape set --

def test_shape_and_colour_names_come_from_the_core_shape_set():
    assert ident.AVATAR_SHAPES == ("blob", "squircle", "pebble", "hex", "teardrop", "tablet")
    assert tuple(SHAPES_JSON["shapes"]) == ident.AVATAR_SHAPES
    assert ident.AVATAR_COLORS == (
        "blue", "orange", "yellow", "magenta", "red", "violet", "black", "green", "gray",
    )
    assert tuple(SHAPES_JSON["colors"]) == ident.AVATAR_COLORS
    assert SHAPES_JSON["view_box"] == "0 0 48 48"
    assert SHAPES_JSON["fill_rule"] == "evenodd"


def test_shape_paths_are_plain_path_data_with_two_eye_holes():
    for name, d in SHAPES_JSON["shapes"].items():
        # path data only: no markup, no url(), no references
        assert re.fullmatch(r"[MCAVZ0-9 .\-]+", d), name
        # outline + two eyes = three closed subpaths
        assert d.count("M") == 3 and d.count("Z") == 3, name


def test_shape_set_is_reproducible_from_the_generator():
    spec = importlib.util.spec_from_file_location("make_shapes", ROOT / "tools/dev/make-avatar-shapes.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.build() == SHAPES_JSON


def test_tokens_define_a_fill_per_colour_and_theme():
    themes, _ = ident.default_theme()
    for theme in ident.THEMES:
        for colour in ident.AVATAR_COLORS + ("default",):
            value = themes[theme][f"--rs-avatar-{colour}"]
            assert ident.ACCENT_RE.fullmatch(value), (theme, colour, value)
        # the default fill is the theme's default accent
        assert themes[theme]["--rs-avatar-default"].lower() == themes[theme]["--rs-accent"].lower()
    # "black" is the ink-like fill: dark on light, white on dark (as in the bot app)
    assert ident.luminance(themes["light"]["--rs-avatar-black"]) < 0.05
    assert themes["dark"]["--rs-avatar-black"].lower() == "#ffffff"


# ------------------------------------------------------------ resolving --

def test_avatar_fields_resolve_from_one_source():
    user = {"x-bot": {"avatar_shape": "hex", "avatar_color": "green"}}
    shipped = {"x-bot": {"avatar_shape": "tablet", "avatar_color": "red"}}
    # the payload states the avatar: no colour mixed in from a registry
    result = resolve("x-bot", {"avatar_shape": "blob"}, user_registry=user, shipped_registry=shipped)
    assert (result["shape"], result["color"]) == ("blob", None)
    result = resolve("x-bot", {"name": "Payload Name"}, user_registry=user, shipped_registry=shipped)
    assert (result["name"], result["shape"], result["color"]) == ("Payload Name", "hex", "green")
    result = resolve("x-bot", None, user_registry={}, shipped_registry=shipped)
    assert (result["shape"], result["color"]) == ("tablet", "red")
    assert result["warnings"] == []


def test_payload_shape_beats_a_registry_image():
    shipped = {"x-bot": {"name": "Shipped", "avatar": data_url(PNG_1PX)}}
    user = {"x-bot": {"avatar": data_url(PNG_1PX), "avatar_shape": "hex"}}
    result = resolve("x-bot", {"avatar_shape": "teardrop", "avatar_color": "yellow"},
                     user_registry=user, shipped_registry=shipped)
    assert result["avatar"] is None
    assert (result["shape"], result["color"]) == ("teardrop", "yellow")
    assert result["name"] == "Shipped"        # name still resolves per field
    assert result["warnings"] == []


def test_payload_colour_alone_beats_a_registry_image():
    shipped = {"x-bot": {"avatar": data_url(PNG_1PX), "avatar_shape": "hex"}}
    result = resolve("x-bot", {"avatar_color": "blue"}, shipped_registry=shipped)
    assert (result["avatar"], result["shape"], result["color"]) == (None, None, "blue")


def test_empty_payload_avatar_clears_a_registry_image():
    shipped = {"x-bot": {"avatar": data_url(PNG_1PX), "avatar_shape": "pebble", "avatar_color": "violet"}}
    result = resolve("x-bot", {"avatar": ""}, shipped_registry=shipped)
    assert (result["avatar"], result["shape"], result["color"]) == (None, None, None)   # initials
    result = resolve("x-bot", {"avatar": " ", "avatar_shape": "blob", "avatar_color": "orange"},
                     shipped_registry=shipped)
    assert (result["avatar"], result["shape"], result["color"]) == (None, "blob", "orange")
    assert result["warnings"] == []


def test_registry_image_is_used_when_the_payload_says_nothing():
    user = {"x-bot": {"avatar": data_url(PNG_1PX), "avatar_shape": "hex"}}
    for payload_identity in (None, {}, {"name": "Payload Name", "accent": "#a855f7"}):
        result = resolve("x-bot", payload_identity, user_registry=user)
        assert result["avatar"]["type"] == "image/png"
        assert result["shape"] == "hex"       # kept for a failing image


def test_within_one_source_an_invalid_image_falls_back_to_its_shape():
    shipped = {"x-bot": {"avatar": data_url(PNG_1PX)}}
    result = resolve("x-bot", {"avatar": "data:image/png;base64,AAAA", "avatar_shape": "hex"},
                     shipped_registry=shipped)
    assert (result["avatar"], result["shape"]) == (None, "hex")
    assert [(item["source"], item["field"]) for item in result["warnings"]] == [("payload", "avatar")]


def test_an_all_invalid_avatar_leaves_the_avatar_to_the_next_source():
    shipped = {"x-bot": {"avatar": data_url(PNG_1PX)}}
    result = resolve("x-bot", {"avatar": "data:image/png;base64,AAAA"}, shipped_registry=shipped)
    assert result["avatar"]["type"] == "image/png"
    assert [(item["source"], item["field"]) for item in result["warnings"]] == [("payload", "avatar")]


def test_defaults_have_no_shape_and_no_colour():
    result = resolve("x-bot")
    assert result["shape"] is None and result["color"] is None


def test_shape_and_colour_are_trimmed_and_case_insensitive():
    result = resolve("x-bot", {"avatar_shape": " Squircle ", "avatar_color": "BLUE"})
    assert (result["shape"], result["color"]) == ("squircle", "blue")
    assert result["warnings"] == []


def test_empty_shape_and_colour_mean_initials_without_a_warning():
    shipped = {"x-bot": {"avatar_shape": "pebble", "avatar_color": "violet"}}
    result = resolve("x-bot", {"avatar_shape": "", "avatar_color": "  "}, shipped_registry=shipped)
    # an explicit empty payload value: no shape from a registry either
    assert (result["shape"], result["color"]) == (None, None)
    assert result["accent"] is None
    assert result["warnings"] == []


def test_unknown_shape_or_colour_falls_back_with_a_warning():
    shipped = {"x-bot": {"avatar_shape": "pebble", "avatar_color": "violet"}}
    result = resolve("x-bot", {"avatar_shape": "star", "avatar_color": "teal"}, shipped_registry=shipped)
    # unknown = the source chose something core cannot draw: initials circle
    # and default fill as specified, not a lower source's shape
    assert result["shape"] is None and result["color"] is None
    reasons = {item["field"]: item["reason"] for item in result["warnings"]}
    assert reasons == {
        "avatar_shape": "unknown value; initials avatar used",
        "avatar_color": "unknown value; default colour used",
    }
    # never echoes the supplied value
    text = json.dumps(result["warnings"])
    assert "star" not in text and "teal" not in text


@pytest.mark.parametrize("value", [42, None, ["blob"], {"shape": "blob"}, True])
def test_wrong_type_is_ignored_and_the_next_source_used(value):
    shipped = {"x-bot": {"avatar_shape": "hex", "avatar_color": "gray"}}
    result = resolve("x-bot", {"avatar_shape": value, "avatar_color": value}, shipped_registry=shipped)
    assert (result["shape"], result["color"]) == ("hex", "gray")
    assert {(item["source"], item["field"]) for item in result["warnings"]} == {
        ("payload", "avatar_shape"), ("payload", "avatar_color"),
    }
    assert all(item["reason"] == "must be a string" for item in result["warnings"])


def test_colour_seeds_the_accent_through_the_contrast_check():
    themes, _ = ident.default_theme()
    result = resolve("x-bot", {"avatar_shape": "blob", "avatar_color": "violet"})
    assert result["accent_value"] is None
    assert result["accent_source"] == "avatar_color"
    assert result["accent"] is not None
    for theme in ident.THEMES:
        token = result["accent"][theme]["--rs-accent"]
        if theme in result["accent_fallback"]:
            assert token == themes[theme]["--rs-accent"].lower()
        else:
            assert token == themes[theme]["--rs-avatar-violet"].lower()
    # a seeded accent that fails a check falls back quietly, without a warning
    assert result["warnings"] == []


def test_low_contrast_colour_seed_falls_back_per_theme():
    # the bright yellow fill is too light against white paper
    result = resolve("x-bot", {"avatar_color": "yellow"})
    assert "light" in result["accent_fallback"]
    assert result["warnings"] == []


def test_explicit_accent_wins_over_the_colour_seed():
    result = resolve("x-bot", {"avatar_color": "orange", "accent": "#a855f7"})
    assert result["accent_source"] == "accent"
    assert result["accent"]["light"]["--rs-accent"] == "#a855f7"


def test_no_colour_means_no_seed():
    result = resolve("x-bot", {"avatar_shape": "blob"})
    assert result["accent"] is None and result["accent_source"] is None


def test_public_identity_carries_shape_and_colour_next_to_the_image():
    result = resolve("x-bot", {"name": "A", "avatar": data_url(PNG_1PX), "avatar_shape": "hex", "avatar_color": "red"})
    rail = ident.public_identity(result, with_accent=False)
    assert set(rail) == {"name", "initials", "avatar", "shape", "color"}
    assert rail["avatar"].startswith("/avatar/")             # the image wins on the page
    assert (rail["shape"], rail["color"]) == ("hex", "red")  # used if the image fails


# ------------------------------------------------------ doctor and serve --

def test_registry_warnings_list_invalid_and_unknown_identity_fields(tmp_path):
    (tmp_path / "bots.json").write_text(json.dumps({
        "a-bot": {"name": "Fine", "avatar_shape": "blob", "avatar_color": "blue"},
        "b-bot": {"avatar_shape": 7, "avatar_color": "teal"},
        "c-bot": "Legacy Name",
    }), encoding="utf-8")
    warnings = ident.registry_warnings(tmp_path)
    assert warnings == [
        "user bots.json b-bot: avatar_shape must be a string",
        "user bots.json b-bot: avatar_color unknown value; default colour used",
    ]


def test_doctor_reports_identity_warnings(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "bots.json").write_text(json.dumps({"b-bot": {"avatar_color": 3}}), encoding="utf-8")
    env = dict(os.environ, RS_DATA_DIR=str(data_dir), PYTHONDONTWRITEBYTECODE="1")
    done = subprocess.run(
        [sys.executable, str(ROOT / "report_shell.py"), "doctor"],
        capture_output=True, text=True, env=env, timeout=60,
    )
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout)["identity_warnings"] == [
        "user bots.json b-bot: avatar_color must be a string",
    ]


def test_server_serves_shape_identity(server):
    run = server.runs.register(validate_payload(payload(
        bot="example-shape-bot", data=starter_data(),
        identity={"name": "Shape Agent", "avatar_shape": "teardrop", "avatar_color": "blue"},
    ), server.registry))
    detail = json.loads(get(server, f"/api/run/{run['run_id']}")[2])
    assert detail["identity"]["shape"] == "teardrop"
    assert detail["identity"]["color"] == "blue"
    assert detail["identity"]["avatar"] is None
    runs = json.loads(get(server, "/api/runs")[2])["runs"]
    rail = next(item for item in runs if item["run_id"] == run["run_id"])
    assert (rail["identity"]["shape"], rail["identity"]["color"]) == ("teardrop", "blue")
    assert "accent" not in rail["identity"]


def test_page_boot_carries_the_core_shape_set(server):
    _, _, body = get(server, "/")
    match = re.search(r'<script id="rs-boot" type="application/json">(.*?)</script>', body.decode("utf-8"), re.S)
    boot = json.loads(match.group(1))
    assert boot["avatar_shapes"] == SHAPES_JSON
