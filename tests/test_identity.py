"""Per-bot identity parsing, precedence, validation and contrast fallback."""
import base64
import json
import subprocess
import sys
import threading
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import pytest

from core import identity as ident
from core.envelope import validate_payload
from core.paths import ensure_layout, load_config
from core.registry import scan_registry
from core.server import Handler, ReportHTTPServer


ROOT = Path(__file__).resolve().parents[1]
PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)
GIF_1PX = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"
JPEG_HEAD = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00"
WEBP_HEAD = b"RIFF\x1a\x00\x00\x00WEBPVP8L"


def data_url(body, kind="image/png"):
    return f"data:{kind};base64," + base64.b64encode(body).decode("ascii")


def resolve(bot="example-bot", payload=None, **kwargs):
    kwargs.setdefault("user_registry", {})
    kwargs.setdefault("shipped_registry", {})
    return ident.resolve_identity(bot, payload, **kwargs)


# ------------------------------------------------------------- parsing --

def test_legacy_string_and_object_registry_forms():
    shipped = {"a-bot": "Inbox Agent", "b-bot": {"name": "Research Agent", "accent": "#0891B2"}}
    assert resolve("a-bot", shipped_registry=shipped)["name"] == "Inbox Agent"
    result = resolve("b-bot", shipped_registry=shipped)
    assert result["name"] == "Research Agent"
    assert result["accent_value"] == "#0891b2"
    assert ident.display_names(shipped) == {"a-bot": "Inbox Agent", "b-bot": "Research Agent"}


def test_shipped_registry_is_neutral_and_mixes_both_forms():
    shipped = json.loads((ROOT / "core" / "bots.json").read_text(encoding="utf-8"))
    names = ident.display_names(shipped)
    assert "Inbox Agent" in names.values() and "Research Agent" in names.values()
    assert any(isinstance(value, str) for value in shipped.values())
    assert any(isinstance(value, dict) for value in shipped.values())
    text = json.dumps(shipped).lower()
    for banned in ("grok", "xai", "official"):
        assert banned not in text
    for bot in shipped:
        result = ident.resolve_identity(bot, None, user_registry={})
        assert result["warnings"] == [], (bot, result["warnings"])
        assert (result["avatar"], result["shape"], result["color"], result["accent"]) == (
            None, None, None, None,
        )


def test_defaults_name_is_bot_id_initials_and_no_accent():
    result = resolve("report-shell-test")
    assert result["name"] == "report-shell-test"
    assert result["initials"] == "RS"
    assert result["avatar"] is None
    assert result["accent"] is None
    assert result["accent_fallback"] == []
    assert result["warnings"] == []


@pytest.mark.parametrize("name,expected", [
    ("Inbox Agent", "IA"),
    ("research", "R"),
    ("  Mobile   Release  Agent ", "MR"),
    ("élan vital", "ÉV"),
    ("42 Bot", "4B"),
    ("-", "-"),
])
def test_initials(name, expected):
    assert ident.initials(name) == expected


# ---------------------------------------------------------- precedence --

def test_precedence_per_field_payload_user_shipped_default(tmp_path):
    user = {"x-bot": {"name": "User Name", "accent": "#a855f7"}}
    shipped = {"x-bot": {"name": "Shipped Name", "accent": "#3d8b6e", "avatar": data_url(PNG_1PX)}}
    result = resolve(
        "x-bot", {"name": "Payload Name"},
        user_registry=user, shipped_registry=shipped, data_dir=tmp_path,
    )
    assert result["name"] == "Payload Name"            # payload
    assert result["accent_value"] == "#a855f7"          # user registry
    assert result["avatar"]["type"] == "image/png"      # shipped registry
    only_shipped = resolve("x-bot", None, user_registry={}, shipped_registry=shipped)
    assert only_shipped["name"] == "Shipped Name"


def test_user_registry_is_read_from_the_data_dir_before_the_shipped_one(tmp_path):
    (tmp_path / "bots.json").write_text(
        json.dumps({"inbox-agent": {"name": "My Mail Helper"}}), encoding="utf-8"
    )
    shipped = {"inbox-agent": {"name": "Inbox Agent", "avatar": data_url(PNG_1PX)}}
    result = ident.resolve_identity(
        "inbox-agent", None, data_dir=tmp_path, shipped_registry=shipped
    )
    assert result["name"] == "My Mail Helper"
    # the user entry states no avatar: the shipped one still applies
    assert result["avatar"] is not None


def test_user_registry_avatar_is_relative_to_the_data_dir(tmp_path):
    (tmp_path / "avatars").mkdir()
    (tmp_path / "avatars" / "me.gif").write_bytes(GIF_1PX)
    (tmp_path / "bots.json").write_text(
        json.dumps({"x-bot": {"avatar": "avatars/me.gif"}}), encoding="utf-8"
    )
    result = ident.resolve_identity("x-bot", None, data_dir=tmp_path, shipped_registry={})
    assert result["avatar"]["type"] == "image/gif"
    assert result["warnings"] == []


def test_broken_user_registry_warns_and_falls_back(tmp_path):
    (tmp_path / "bots.json").write_text("{not json", encoding="utf-8")
    result = ident.resolve_identity("inbox-agent", None, data_dir=tmp_path)
    assert result["name"] == "Inbox Agent"
    assert result["warnings"][0]["source"] == "user"


def test_invalid_value_falls_through_to_the_next_source():
    shipped = {"x-bot": {"name": "Shipped Name", "accent": "#a855f7"}}
    result = resolve("x-bot", {"name": "\u0007bell", "accent": "red"}, shipped_registry=shipped)
    assert result["name"] == "Shipped Name"
    assert result["accent_value"] == "#a855f7"
    fields = {(item["source"], item["field"]) for item in result["warnings"]}
    assert fields == {("payload", "name"), ("payload", "accent")}


def test_non_object_identity_and_unknown_keys_only_warn():
    result = resolve("x-bot", "Inbox Agent", has_payload_identity=True)
    assert result["name"] == "x-bot"
    assert result["warnings"] == [{"source": "payload", "field": None, "reason": "identity must be an object"}]
    result = resolve("x-bot", {"name": "Ok", "color": "#000000"})
    assert result["name"] == "Ok"
    assert result["warnings"][0]["field"] == "color"


# ---------------------------------------------------------- validation --

@pytest.mark.parametrize("value", [
    "", "   ", "x" * 41, 42, None, "a\nb", "tab\there", "rtl‮override", "line sep",
])
def test_name_rejects_empty_long_and_control_characters(value):
    with pytest.raises(ident.IdentityIssue):
        ident.validate_name(value)


def test_name_is_trimmed_and_may_be_forty_characters():
    assert ident.validate_name("  Inbox Agent ") == "Inbox Agent"
    assert ident.validate_name("x" * 40) == "x" * 40
    assert ident.validate_name("<b>Agent</b>") == "<b>Agent</b>"   # rendered as text only


@pytest.mark.parametrize("value", ["#fff", "0891b2", "#0891b2ff", "rgb(0,0,0)", "red", "#GGGGGG", 123])
def test_accent_accepts_only_rrggbb(value):
    with pytest.raises(ident.IdentityIssue):
        ident.validate_accent(value)


def test_accent_is_normalized_to_lower_case():
    assert ident.validate_accent("#0891B2") == "#0891b2"


@pytest.mark.parametrize("body,kind", [
    (PNG_1PX, "image/png"), (GIF_1PX, "image/gif"),
    (JPEG_HEAD + b"\x00" * 16, "image/jpeg"), (WEBP_HEAD + b"\x00" * 16, "image/webp"),
])
def test_avatar_data_urls_of_the_four_raster_types(body, kind):
    avatar = ident.load_avatar(data_url(body, kind))
    assert avatar["type"] == kind
    assert base64.b64decode(avatar["data"]) == body


@pytest.mark.parametrize("value", [
    "data:image/svg+xml;base64," + base64.b64encode(b"<svg onload='x()'/>").decode(),
    "data:image/png;base64," + base64.b64encode(b"<svg/>").decode(),      # declared PNG, is not
    "data:image/gif;base64," + base64.b64encode(PNG_1PX).decode(),        # type mismatch
    "data:image/png,rawbytes",
    "data:image/png;base64,!!!!",
    "data:image/png;base64,",
    "https://example.invalid/a.png",
])
def test_avatar_rejects_svg_mismatch_and_non_base64(value):
    with pytest.raises(ident.IdentityIssue):
        ident.load_avatar(value)


def test_avatar_size_cap_is_256_kb(tmp_path):
    big = PNG_1PX + b"\x00" * (ident.AVATAR_MAX - len(PNG_1PX) + 1)
    with pytest.raises(ident.IdentityIssue, match="256 KB"):
        ident.load_avatar(data_url(big))
    exact = PNG_1PX + b"\x00" * (ident.AVATAR_MAX - len(PNG_1PX))
    assert ident.load_avatar(data_url(exact))["type"] == "image/png"
    (tmp_path / "big.png").write_bytes(big)
    with pytest.raises(ident.IdentityIssue, match="256 KB"):
        ident.load_avatar("big.png", tmp_path)


def test_avatar_path_trust_rules(tmp_path):
    base = tmp_path / "template"
    data_dir = tmp_path / "data"
    (base / "media").mkdir(parents=True)
    data_dir.mkdir()
    (base / "media" / "a.png").write_bytes(PNG_1PX)
    (base / "media" / "fake.png").write_bytes(b"<svg/>")
    (base / "media" / "icon.svg").write_bytes(b"<svg/>")
    (base / "media" / "wrong.gif").write_bytes(PNG_1PX)
    (tmp_path / "outside.png").write_bytes(PNG_1PX)
    (data_dir / "inside.png").write_bytes(PNG_1PX)

    assert ident.load_avatar("media/a.png", base, data_dir)["type"] == "image/png"
    assert ident.load_avatar("%RS_TEMPLATE%/media/a.png", base, data_dir)["type"] == "image/png"
    assert ident.load_avatar(str(data_dir / "inside.png"), base, data_dir)["type"] == "image/png"
    for bad in (
        "../outside.png", "media/../../outside.png", str(tmp_path / "outside.png"),
        "\\\\server\\share\\a.png", "//server/share/a.png", "media/missing.png",
        "media/icon.svg", "media/fake.png", "media/wrong.gif", "media", "C:relative.png",
    ):
        with pytest.raises(ident.IdentityIssue):
            ident.load_avatar(bad, base, data_dir)


def test_avatar_path_value_errors_are_normalized_to_identity_issues(monkeypatch):
    def invalid_path(*_args):
        raise ValueError("platform path parser rejected the value")

    monkeypatch.setattr(ident, "_avatar_path", invalid_path)
    with pytest.raises(ident.IdentityIssue, match="path is invalid"):
        ident.load_avatar("avatar.png", Path("."), Path("."))


@pytest.mark.skipif(sys.platform != "win32", reason="junctions are Windows-specific")
def test_avatar_junction_escape_is_rejected(tmp_path):
    base = tmp_path / "template"
    outside = tmp_path / "outside"
    base.mkdir()
    outside.mkdir()
    (outside / "a.png").write_bytes(PNG_1PX)
    created = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(base / "link"), str(outside)], capture_output=True
    )
    if created.returncode:
        pytest.skip("junction creation unavailable")
    with pytest.raises(ident.IdentityIssue, match="outside"):
        ident.load_avatar("link/a.png", base, tmp_path / "data")


def test_broken_avatar_warns_and_falls_back_to_initials():
    result = resolve("x-bot", {"name": "Calendar Agent", "avatar": "avatars/missing.png"})
    assert result["avatar"] is None
    assert result["initials"] == "CA"
    assert result["warnings"][0]["field"] == "avatar"


# ------------------------------------------------------------ contrast --

def test_contrast_math_matches_wcag_reference_values():
    assert ident.contrast("#000000", "#ffffff") == pytest.approx(21.0)
    assert ident.contrast("#777777", "#ffffff") == pytest.approx(4.48, abs=.01)
    assert ident.contrast("#ffffff", "#ffffff") == pytest.approx(1.0)


def test_theme_tokens_are_parsed_from_tokens_css():
    themes, focus = ident.default_theme()
    assert themes["light"]["--rs-accent"] == "#3b4fd8"
    assert themes["dark"]["--rs-accent"] == "#8f9cf7"
    assert {"--rs-paper", "--rs-card", "--rs-rail-bg", "--rs-selected"} <= set(focus)


def test_default_accents_pass_their_own_theme():
    themes, focus = ident.default_theme()
    for theme in ident.THEMES:
        tokens, failures = ident.accent_tokens(themes[theme]["--rs-accent"], themes[theme], focus)
        assert failures == [], (theme, failures)
        assert ident.contrast(tokens["--rs-on-accent"], tokens["--rs-accent"]) >= 4.5


def test_hover_fill_contrast_falls_back_only_in_the_failing_theme():
    tokens, fallback, failures = ident.theme_accents("#0891b2")
    themes, _ = ident.default_theme()
    assert fallback == ["light"]
    assert tokens["light"]["--rs-accent"] == themes["light"]["--rs-accent"]
    assert tokens["dark"]["--rs-accent"] == "#0891b2"
    assert [item["pair"] for item in failures["light"]] == [
        "--rs-accent-hover/--rs-paper",
        "--rs-accent-hover/--rs-card",
    ]
    assert ident.contrast(
        tokens["dark"]["--rs-accent-hover"],
        themes["dark"]["--rs-paper"],
    ) >= 3


def test_on_accent_is_the_higher_contrast_of_black_and_white():
    themes, focus = ident.default_theme()
    tokens, _ = ident.accent_tokens("#1f3a5f", themes["light"], focus)
    assert tokens["--rs-on-accent"] == "#ffffff"
    tokens, _ = ident.accent_tokens("#f6c945", themes["dark"], focus)
    assert tokens["--rs-on-accent"] == "#000000"


def test_low_contrast_accent_falls_back_per_theme():
    themes, _ = ident.default_theme()
    tokens, fallback, failures = ident.theme_accents("#f6c945")    # pale: fails on white
    assert fallback == ["light"]
    assert tokens["light"]["--rs-accent"] == themes["light"]["--rs-accent"]
    assert tokens["dark"]["--rs-accent"] == "#f6c945"
    assert any(item["pair"] == "--rs-accent/--rs-paper" for item in failures["light"])
    tokens, fallback, _ = ident.theme_accents("#1f3a5f")           # dark navy: fails on dark
    assert fallback == ["dark"]
    assert tokens["dark"]["--rs-accent"] == themes["dark"]["--rs-accent"]


def test_resolve_records_accent_fallback_and_a_warning():
    result = resolve("x-bot", {"accent": "#f6c945"})
    assert result["accent_fallback"] == ["light"]
    assert result["accent"]["dark"]["--rs-accent"] == "#f6c945"
    warning = [item for item in result["warnings"] if item["source"] == "accent"]
    assert warning and warning[0]["theme"] == "light"


def test_focus_ring_check_covers_every_focus_background():
    themes, focus = ident.default_theme()
    # passes paper and card but not the darker selected segment in dark
    tokens, failures = ident.accent_tokens("#d9480f", themes["dark"], focus)
    assert tokens is None
    assert [item["pair"] for item in failures] == ["--rs-focus/--rs-selected"]


def test_public_identity_never_exposes_paths_or_foreign_accents():
    result = resolve("x-bot", {"name": "A", "accent": "#a855f7", "avatar": data_url(PNG_1PX)})
    rail = ident.public_identity(result, with_accent=False)
    assert set(rail) == {"name", "initials", "avatar", "shape", "color"}
    assert rail["avatar"].startswith("/avatar/") and len(rail["avatar"]) == len("/avatar/") + 64
    active = ident.public_identity(result, with_accent=True)
    assert active["accent"]["light"]["--rs-accent"] == "#a855f7"


# ---------------------------------------------------------- integration --

def payload(**extra):
    value = {
        "schema": "report-shell/payload@1",
        "template": "_starter",
        "version": 1,
        "bot": "inbox-agent",
        "title": "Identity test",
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "data": {"message": "Hello", "copy": {"label": "x", "text": "y"}},
    }
    value.update(extra)
    return value


@pytest.fixture()
def server(tmp_path):
    data_dir = ensure_layout(tmp_path / "data")
    instance = ReportHTTPServer(
        ("127.0.0.1", 0), Handler, data_dir, scan_registry(ROOT / "templates"), load_config(data_dir)
    )
    instance.port = instance.server_port
    thread = threading.Thread(target=instance.serve_forever, daemon=True)
    thread.start()
    try:
        yield instance
    finally:
        instance.stopping.set()
        instance.shutdown()
        instance.server_close()
        thread.join(timeout=2)


def starter_data():
    return json.loads((ROOT / "templates/builtin/_starter/fixtures/golden.json").read_text(encoding="utf-8"))


def get(server, path):
    request = urllib.request.Request(
        f"http://127.0.0.1:{server.port}{path}",
        headers={"Host": f"127.0.0.1:{server.port}", "X-RS-CSRF": server.csrf},
    )
    with urllib.request.urlopen(request, timeout=3) as response:
        return response.status, response.headers, response.read()


def push(server, value):
    request = urllib.request.Request(
        f"http://127.0.0.1:{server.port}/push",
        data=json.dumps(value).encode("utf-8"),
        headers={
            "Host": f"127.0.0.1:{server.port}",
            "X-RS-Token": server.token,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=3) as response:
        return response.status, json.loads(response.read())


def log_events(data_dir):
    return [
        json.loads(line)
        for path in (Path(data_dir) / "log").glob("*.jsonl")
        for line in path.read_text(encoding="utf-8").splitlines()
    ]


def test_envelope_accepts_any_identity_value_without_rejecting():
    registry = scan_registry(ROOT / "templates")
    for value in ({"name": "A"}, "not an object", 42, None, {"accent": "red"}):
        validated = validate_payload(payload(identity=value, data=starter_data()), registry)
        assert validated["identity"] == value


def test_server_resolves_identity_serves_avatar_and_logs_warnings(server):
    registry = server.registry
    good = validate_payload(payload(
        bot="example-bot", data=starter_data(),
        identity={"name": "Research Agent", "accent": "#a855f7", "avatar": data_url(PNG_1PX)},
    ), registry)
    bad = validate_payload(payload(
        bot="other-bot", data=starter_data(),
        identity={"name": "Calendar Agent", "accent": "#f6c945", "avatar": "data:image/svg+xml;base64,PHN2Zy8+"},
    ), registry)
    first = server.runs.register(good)
    second = server.runs.register(bad)

    status, _, body = get(server, f"/api/run/{first['run_id']}")
    detail = json.loads(body)
    assert detail["bot_display"] == "Research Agent"
    assert detail["identity"]["accent"]["light"]["--rs-accent"] == "#a855f7"
    avatar_url = detail["identity"]["avatar"]
    status, headers, image = get(server, avatar_url)
    assert status == 200 and image == PNG_1PX
    assert headers["Content-Type"] == "image/png"
    assert headers["X-Content-Type-Options"] == "nosniff"

    status, _, body = get(server, "/api/runs")
    runs = json.loads(body)["runs"]
    assert {run["identity"]["name"] for run in runs} == {"Research Agent", "Calendar Agent"}
    assert all("accent" not in run["identity"] for run in runs)     # no foreign accents

    detail = json.loads(get(server, f"/api/run/{second['run_id']}")[2])
    assert detail["identity"]["avatar"] is None
    assert detail["identity"]["initials"] == "CA"
    assert detail["identity"]["accent_fallback"] == ["light"]
    warnings = [
        event for event in log_events(server.data_dir)
        if event["run_id"] == second["run_id"] and event["event"] == "warning"
    ]
    assert {event["detail"]["what"] for event in warnings} == {"identity_invalid", "accent_fallback"}

    result_path = server.runs.decide(second["run_id"], "cancelled")
    result = json.loads(Path(result_path).read_text(encoding="utf-8"))
    assert result["identity"]["accent_fallback"] == ["light"]
    assert result["identity"]["warnings"][0]["field"] == "avatar"
    result_path = server.runs.decide(first["run_id"], "cancelled")
    assert "identity" not in json.loads(Path(result_path).read_text(encoding="utf-8"))


def test_push_nul_avatar_warns_and_uses_lower_priority_avatar_sources(server):
    avatars = Path(server.data_dir) / "avatars"
    avatars.mkdir()
    (avatars / "user.png").write_bytes(PNG_1PX)
    (Path(server.data_dir) / "bots.json").write_text(json.dumps({
        "example-user-bot": {"avatar": "avatars/user.png"},
        "inbox-agent": {"avatar": "bad\u0000.png"},
    }), encoding="utf-8")

    status, first = push(server, payload(
        bot="example-user-bot",
        data=starter_data(),
        identity={"name": "Safe Name", "accent": "#0891b2", "avatar": "bad\u0000.png"},
    ))
    assert status == 200
    detail = json.loads(get(server, f"/api/run/{first['run_id']}")[2])
    assert detail["identity"]["name"] == "Safe Name"
    assert detail["identity"]["accent"]["dark"]["--rs-accent"] == "#0891b2"
    assert detail["identity"]["accent_fallback"] == ["light"]
    avatar_status, _, avatar_body = get(server, detail["identity"]["avatar"])
    assert avatar_status == 200 and avatar_body == PNG_1PX

    status, second = push(server, payload(
        bot="inbox-agent",
        data=starter_data(),
    ))
    assert status == 200
    detail = json.loads(get(server, f"/api/run/{second['run_id']}")[2])
    assert detail["identity"]["avatar"] is None
    assert detail["identity"]["initials"] == "IA"

    warnings = {
        event["run_id"]: event["detail"]
        for event in log_events(server.data_dir)
        if event["event"] == "warning"
        and event["detail"].get("what") == "identity_invalid"
        and event["detail"].get("field") == "avatar"
    }
    assert warnings[first["run_id"]]["source"] == "payload"
    assert warnings[second["run_id"]]["source"] == "user"
    for pushed, source in ((first, "payload"), (second, "user")):
        result_path = server.runs.decide(pushed["run_id"], "cancelled")
        result = json.loads(Path(result_path).read_text(encoding="utf-8"))
        avatar_warnings = [
            warning for warning in result["identity"]["warnings"]
            if warning["field"] == "avatar"
        ]
        assert avatar_warnings[0]["source"] == source


def test_unknown_avatar_hash_is_404(server):
    with pytest.raises(urllib.error.HTTPError) as error:
        get(server, "/avatar/" + "0" * 64)
    assert error.value.code == 404
    with pytest.raises(urllib.error.HTTPError) as error:
        get(server, "/avatar/../bots.json")
    assert error.value.code == 404


def test_identity_survives_a_server_restart(tmp_path):
    data_dir = ensure_layout(tmp_path / "data")
    registry = scan_registry(ROOT / "templates")
    first = ReportHTTPServer(("127.0.0.1", 0), Handler, data_dir, registry, load_config(data_dir))
    try:
        run = first.runs.register(validate_payload(payload(
            data=starter_data(), identity={"avatar": data_url(PNG_1PX), "accent": "#0891b2"},
        ), registry))
    finally:
        first.server_close()
    second = ReportHTTPServer(("127.0.0.1", 0), Handler, data_dir, registry, load_config(data_dir))
    try:
        detail = second.runs.detail(run["run_id"], second.bots)
        sha = detail["identity"]["avatar"].rsplit("/", 1)[-1]
        assert second.runs.avatars[sha][0] == PNG_1PX
        assert detail["identity"]["name"] == "Inbox Agent"
    finally:
        second.server_close()
