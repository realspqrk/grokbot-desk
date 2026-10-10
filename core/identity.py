"""Per-bot identity: name, avatar, shape avatar and accent (addenda 2026-10-08, 2026-10-10).

Sources: payload ``identity`` > user registry (``<data dir>/bots.json``)
> shipped registry (``core/bots.json``) > defaults (name = bot id, initials
avatar, theme accent). A registry entry is either the legacy string form
(``"id": "Display name"``) or ``{"name", "avatar", "accent", "avatar_shape",
"avatar_color"}``. Name and accent resolve per field. The avatar fields
(``avatar``, ``avatar_shape``, ``avatar_color``) resolve per source (fix1):
the first source that states any of them, validly or explicitly empty, decides
the whole avatar, so an explicit payload identity beats any registry image and
an empty payload value clears it. Within that source: image > shape + colour
> initials.

Identity problems never reject a report: an invalid value is dropped with a
warning and the next source is used. A valid accent that fails the WCAG checks
in a theme falls back to that theme's default accent; the theme is recorded in
``accent_fallback``.

Shape avatars (P8c): ``avatar_shape`` and ``avatar_color`` name one of the
fixed shapes and fills of ``static/avatar-shapes.json`` (core draws them; no
SVG is ever taken from a bot). Empty = no value (initials), but the source
still decides the avatar; a wrong type is dropped with a warning (a source
whose avatar fields are all invalid leaves the avatar to the next source); an
unknown name is a warning and resolves to "none" (initials circle, default
fill). Without an explicit accent the colour seeds the accent, through the
same per-theme checks (a failing theme falls back quietly).
"""
import base64
import binascii
import hashlib
import os
import re
import stat
import unicodedata
from pathlib import Path, PureWindowsPath

from .jsonutil import loads
from .media import TEMPLATE_TOKEN, MediaError, _is_relative_to, _template_relative_parts
from .platform import (
    PathIdentityError,
    ReparseEscape,
    final_path_for_handle,
    open_contained,
)


CORE = Path(__file__).resolve().parent
SHIPPED_REGISTRY = CORE / "bots.json"
TOKENS_CSS = CORE / "static" / "tokens.css"
CONTRAST_PAIRS = CORE / "static" / "contrast-pairs.json"
AVATAR_SHAPES_JSON = CORE / "static" / "avatar-shapes.json"

FIELDS = ("name", "avatar", "accent", "avatar_shape", "avatar_color")
ENUM_FIELDS = ("avatar_shape", "avatar_color")
# resolved together, from one source (fix1)
AVATAR_FIELDS = ("avatar", "avatar_shape", "avatar_color")
THEMES = ("light", "dark")
NAME_MAX = 40
AVATAR_MAX = 256 * 1024
ACCENT_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
AVATAR_TYPES = {
    "image/png": (".png",),
    "image/jpeg": (".jpg", ".jpeg"),
    "image/webp": (".webp",),
    "image/gif": (".gif",),
}
DATA_URL_RE = re.compile(r"^data:(image/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]*)$")
# Bidi overrides/isolates and marks can reorder a visible name; reject them.
BIDI_CONTROLS = set("؜‎‏‪‫‬‭‮⁦⁧⁨⁩")
ACCENT_TOKENS = ("--rs-accent", "--rs-accent-hover", "--rs-on-accent", "--rs-focus")
ON_ACCENT_CHOICES = ("#ffffff", "#000000")
HOVER_MIX = 0.15
# WCAG checks for a custom accent, per theme (spec 3): accent and hover fills
# against page/surface >= 3:1 (1.4.11), label on either fill >= 4.5:1 (AA),
# and the focus ring (= accent) >= 3:1 against every background it is drawn on
# (the --rs-focus pairs of contrast-pairs.json).
FILL_BACKGROUNDS = ("--rs-paper", "--rs-card")
LABEL_MIN = 4.5
NON_TEXT_MIN = 3.0


class IdentityIssue(ValueError):
    pass


class Omitted(Exception):
    """An empty shape/colour value: as if the field were not there."""


def shape_set():
    """The core shape set: {"view_box", "fill_rule", "shapes": {name: path}, "colors": [...]}."""
    return loads(AVATAR_SHAPES_JSON.read_text(encoding="utf-8"))


_SHAPE_SET = shape_set()
AVATAR_SHAPES = tuple(_SHAPE_SET["shapes"])
AVATAR_COLORS = tuple(_SHAPE_SET["colors"])
UNKNOWN_REASON = {
    "avatar_shape": "unknown value; initials avatar used",
    "avatar_color": "unknown value; default colour used",
}


# ----------------------------------------------------------- colour math --

def _rgb(value):
    value = value.strip()
    if not ACCENT_RE.fullmatch(value):
        raise ValueError(f"expected #RRGGBB, got {value!r}")
    return tuple(int(value[index:index + 2], 16) for index in (1, 3, 5))


def _hex(rgb):
    return "#" + "".join(f"{max(0, min(255, round(channel))):02x}" for channel in rgb)


def luminance(value):
    channels = []
    for channel in _rgb(value):
        normalized = channel / 255
        channels.append(
            normalized / 12.92 if normalized <= 0.04045
            else ((normalized + 0.055) / 1.055) ** 2.4
        )
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]


def contrast(left, right):
    bright, dark = sorted((luminance(left), luminance(right)), reverse=True)
    return (bright + 0.05) / (dark + 0.05)


def mix(value, target, amount):
    source, goal = _rgb(value), _rgb(target)
    return _hex(tuple(a + (b - a) * amount for a, b in zip(source, goal)))


# ---------------------------------------------------------- theme tokens --

_TOKEN_RE = re.compile(r"(--[\w-]+)\s*:\s*([^;{}]+);")
_COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)


def parse_theme_tokens(css):
    """Return {"light": {...}, "dark": {...}} from tokens.css."""
    clean = _COMMENT_RE.sub("", css)
    root = re.search(r":root\s*\{([^{}]*)\}", clean)
    dark = re.findall(r"html\[data-theme=[\"']dark[\"']\]\s*\{([^{}]*)\}", clean)
    if not root or not dark:
        raise ValueError("tokens.css needs a :root and an html[data-theme=\"dark\"] block")
    light_tokens = {name: value.strip() for name, value in _TOKEN_RE.findall(root.group(1))}
    dark_tokens = dict(light_tokens)
    dark_tokens.update({name: value.strip() for name, value in _TOKEN_RE.findall(dark[-1])})
    return {"light": light_tokens, "dark": dark_tokens}


def focus_backgrounds(pairs):
    return tuple(
        pair["bg"] for pair in pairs.get("pairs", [])
        if pair.get("fg") == "--rs-focus"
    )


_THEME_CACHE = {}


def default_theme():
    """Theme tokens and focus backgrounds of the shipped design system."""
    if "value" not in _THEME_CACHE:
        tokens = parse_theme_tokens(TOKENS_CSS.read_text(encoding="utf-8"))
        pairs = loads(CONTRAST_PAIRS.read_text(encoding="utf-8"))
        _THEME_CACHE["value"] = (tokens, focus_backgrounds(pairs))
    return _THEME_CACHE["value"]


def accent_tokens(accent, theme_tokens, focus_bgs):
    """Derived accent tokens for one theme, or (None, failures) if a check fails."""
    accent = accent.lower()
    on_accent = max(ON_ACCENT_CHOICES, key=lambda label: contrast(label, accent))
    # hover moves away from the label colour, so the label only gains contrast
    hover = mix(accent, "#000000" if on_accent == "#ffffff" else "#ffffff", HOVER_MIX)
    checks = [
        (f"--rs-accent/{bg}", contrast(accent, theme_tokens[bg]), NON_TEXT_MIN)
        for bg in FILL_BACKGROUNDS
    ]
    checks += [
        (f"--rs-accent-hover/{bg}", contrast(hover, theme_tokens[bg]), NON_TEXT_MIN)
        for bg in FILL_BACKGROUNDS
    ]
    checks += [
        ("--rs-on-accent/--rs-accent", contrast(on_accent, accent), LABEL_MIN),
        ("--rs-on-accent/--rs-accent-hover", contrast(on_accent, hover), LABEL_MIN),
    ]
    checks += [
        (f"--rs-focus/{bg}", contrast(accent, theme_tokens[bg]), NON_TEXT_MIN)
        for bg in focus_bgs if bg in theme_tokens
    ]
    failures = [
        {"pair": name, "ratio": round(ratio, 2), "min": minimum}
        for name, ratio, minimum in checks
        if ratio < minimum
    ]
    if failures:
        return None, failures
    return {
        "--rs-accent": accent,
        "--rs-accent-hover": hover,
        "--rs-on-accent": on_accent,
        "--rs-focus": accent,
    }, []


def theme_accents(accent, themes=None, focus_bgs=None):
    """Per-theme accent tokens plus the themes that fell back to the default.

    ``accent`` is one #rrggbb or a {theme: #rrggbb} map.
    Returns ({"light": tokens, "dark": tokens}, fallback_themes, failures).
    A fallback theme carries the default accent tokens of that theme, so the
    page can always apply both blocks.
    """
    if themes is None or focus_bgs is None:
        default_tokens, default_focus = default_theme()
        themes = themes or default_tokens
        focus_bgs = default_focus if focus_bgs is None else focus_bgs
    result, fallback, failures = {}, [], {}
    for theme in THEMES:
        value = accent[theme] if isinstance(accent, dict) else accent
        tokens, failed = accent_tokens(value, themes[theme], focus_bgs)
        if tokens is None:
            fallback.append(theme)
            failures[theme] = failed
            tokens = {name: themes[theme][name].lower() for name in ACCENT_TOKENS}
        result[theme] = tokens
    return result, fallback, failures


# ------------------------------------------------------------ validation --

def validate_name(value):
    if not isinstance(value, str):
        raise IdentityIssue("must be a string")
    name = value.strip()
    if not 1 <= len(name) <= NAME_MAX:
        raise IdentityIssue(f"must be 1-{NAME_MAX} characters after trimming")
    for char in name:
        category = unicodedata.category(char)
        if category in ("Cc", "Zl", "Zp", "Cs") or char in BIDI_CONTROLS:
            raise IdentityIssue("must not contain control characters")
    return name


def validate_accent(value):
    if not isinstance(value, str) or not ACCENT_RE.fullmatch(value):
        raise IdentityIssue("must be #RRGGBB")
    return value.lower()


def validate_enum(field, value):
    """A known shape/colour name, or None for an unknown one; Omitted when empty."""
    if not isinstance(value, str):
        raise IdentityIssue("must be a string")
    name = value.strip().lower()
    if not name:
        raise Omitted()
    allowed = AVATAR_SHAPES if field == "avatar_shape" else AVATAR_COLORS
    return name if name in allowed else None


def avatar_fill(color, theme, themes=None):
    """The fill of a named colour in one theme (tokens.css --rs-avatar-<name>)."""
    themes = themes or default_theme()[0]
    return themes[theme][f"--rs-avatar-{color}"].lower()


def sniff_image(head):
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    return None


def _decode_data_url(value):
    match = DATA_URL_RE.fullmatch(value)
    if not match:
        raise IdentityIssue("data URL must be data:image/(png|jpeg|webp|gif);base64,...")
    declared, encoded = match.groups()
    encoded = re.sub(r"\s+", "", encoded)
    if len(encoded) > (AVATAR_MAX + 2) // 3 * 4:
        raise IdentityIssue(f"avatar exceeds {AVATAR_MAX // 1024} KB")
    try:
        body = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise IdentityIssue("data URL is not valid base64") from error
    if not body:
        raise IdentityIssue("avatar is empty")
    if len(body) > AVATAR_MAX:
        raise IdentityIssue(f"avatar exceeds {AVATAR_MAX // 1024} KB")
    sniffed = sniff_image(body[:16])
    if sniffed != declared:
        raise IdentityIssue("avatar content is not the declared PNG, JPEG, WebP or GIF image")
    return body, sniffed


def _avatar_extensions():
    return {ext for exts in AVATAR_TYPES.values() for ext in exts}


def _avatar_path(value, base_dir, data_dir):
    """Resolve an avatar path that is not a template token."""
    if "\0" in value:
        raise IdentityIssue("avatar path is invalid")
    windows = PureWindowsPath(value)
    if value.startswith(("\\\\", "//")) or windows.anchor.startswith("\\\\"):
        raise IdentityIssue("UNC paths are not allowed")
    if ".." in windows.parts or ".." in Path(value).parts:
        raise IdentityIssue("'..' is not allowed")
    supplied = Path(value)
    if supplied.is_absolute() or windows.anchor:
        if data_dir is None:
            raise IdentityIssue("absolute paths are only allowed inside the data dir")
        roots = [Path(data_dir)]
        candidate = supplied
    else:
        if base_dir is None:
            raise IdentityIssue("relative avatar path has no base directory")
        roots = [Path(base_dir)]
        candidate = Path(base_dir) / value
    return candidate, roots


def _validated_avatar_body(handle, final_path):
    info = os.fstat(handle.fileno())
    if not stat.S_ISREG(info.st_mode):
        raise IdentityIssue("avatar path is not a regular file")
    if info.st_size > AVATAR_MAX:
        raise IdentityIssue(f"avatar exceeds {AVATAR_MAX // 1024} KB")
    body = handle.read(AVATAR_MAX + 1)
    if len(body) > AVATAR_MAX:
        raise IdentityIssue(f"avatar exceeds {AVATAR_MAX // 1024} KB")
    sniffed = sniff_image(body[:16])
    if sniffed is None:
        raise IdentityIssue("avatar must be a PNG, JPEG, WebP or GIF image")
    if final_path.suffix.lower() not in AVATAR_TYPES[sniffed]:
        raise IdentityIssue("avatar file extension does not match its content")
    return body, sniffed


def _template_avatar_value(value, base_dir, template_root):
    """%RS_TEMPLATE% form for an avatar read from the payload template.

    Bare payload paths are relative to that directory (GUIDE: a path relative
    to the template folder). User and shipped registry avatars keep their own
    bases and return None so they stay on the ordinary reader. Absolute paths
    and UNC paths also return None.
    """
    if value.startswith(TEMPLATE_TOKEN):
        return value
    if template_root is None or base_dir is None:
        return None
    if Path(base_dir) != Path(template_root):
        return None
    if "\0" in value:
        return None
    windows = PureWindowsPath(value)
    if (
        value.startswith(("\\\\", "//"))
        or windows.anchor.startswith("\\\\")
        or bool(windows.anchor)
        or Path(value).is_absolute()
    ):
        return None
    parts = [part for part in re.split(r"[\\/]", value) if part not in {"", "."}]
    if not parts or any(part == ".." for part in parts):
        return None
    return TEMPLATE_TOKEN + "/" + "/".join(parts)


def _read_template_avatar(value, template_root, template_identity):
    """Open a template-relative avatar from the registry-pinned directory.

    The same no-follow relative open used for template media. The directory
    identity captured at scan time is checked again, so a directory put in
    place of the template after the scan cannot authorize an outside image.
    ``value`` is a %RS_TEMPLATE% path. Bare payload paths are rewritten to
    that form by ``_template_avatar_value``.
    """
    if "\0" in value:
        raise IdentityIssue("avatar path is invalid")
    try:
        parts = _template_relative_parts(value, template_root)
    except MediaError as error:
        raise IdentityIssue(str(error)) from error
    if Path(parts[-1]).suffix.lower() not in _avatar_extensions():
        raise IdentityIssue("avatar must be a .png, .jpg, .jpeg, .webp or .gif file")
    try:
        handle, root_final, root_identity, _file_identity = open_contained(
            Path(template_root), parts, template_identity
        )
    except (ReparseEscape, PathIdentityError) as error:
        raise IdentityIssue("avatar path is outside its allowed directory") from error
    except OSError as error:
        raise IdentityIssue("avatar file is unavailable") from error
    try:
        try:
            final_path = final_path_for_handle(handle)
        except OSError as error:
            raise IdentityIssue("avatar file could not be read") from error
        if not _is_relative_to(final_path, root_final):
            raise IdentityIssue("avatar path is outside its allowed directory")
        if (
            template_identity is not None
            and tuple(root_identity) != tuple(template_identity)
        ):
            raise IdentityIssue("avatar path is outside its allowed directory")
        try:
            return _validated_avatar_body(handle, final_path)
        except OSError as error:
            raise IdentityIssue("avatar file could not be read") from error
    finally:
        handle.close()


def _read_avatar_file(candidate, roots):
    if candidate.suffix.lower() not in _avatar_extensions():
        raise IdentityIssue("avatar must be a .png, .jpg, .jpeg, .webp or .gif file")
    try:
        handle = candidate.open("rb")
    except OSError as error:
        raise IdentityIssue("avatar file is unavailable") from error
    with handle:
        try:
            final_path = final_path_for_handle(handle)
            allowed = []
            for root in roots:
                try:
                    allowed.append(Path(root).resolve(strict=True))
                except OSError:
                    continue
            if not any(_is_relative_to(final_path, root) for root in allowed):
                raise IdentityIssue("avatar path is outside its allowed directory")
            return _validated_avatar_body(handle, final_path)
        except IdentityIssue:
            raise
        except OSError as error:
            raise IdentityIssue("avatar file could not be read") from error


def load_avatar(value, base_dir=None, data_dir=None, *, template_root=None, template_identity=None):
    """Validate an avatar value; returns {"sha256", "type", "data"} (data = base64)."""
    if not isinstance(value, str) or not value.strip():
        raise IdentityIssue("must be a non-empty string")
    value = value.strip()
    kind = value[:5].lower()
    token = None if kind == "data:" else _template_avatar_value(value, base_dir, template_root)
    if kind == "data:":
        body, content_type = _decode_data_url(value)
    elif token is not None:
        root = template_root if template_root is not None else base_dir
        try:
            body, content_type = _read_template_avatar(token, root, template_identity)
        except IdentityIssue:
            raise
        except ValueError as error:
            raise IdentityIssue("avatar path is invalid") from error
    else:
        try:
            candidate, roots = _avatar_path(value, base_dir, data_dir)
            body, content_type = _read_avatar_file(candidate, roots)
        except IdentityIssue:
            raise
        except ValueError as error:
            raise IdentityIssue("avatar path is invalid") from error
    return {
        "sha256": hashlib.sha256(body).hexdigest(),
        "type": content_type,
        "data": base64.b64encode(body).decode("ascii"),
    }


def initials(name):
    words = [word for word in re.split(r"[\s_\-.]+", name) if word]
    letters = []
    for word in words[:2]:
        for char in word:
            if char.isalnum():
                letters.append(char.upper())
                break
    return "".join(letters) or name[:1].upper()


# --------------------------------------------------------------- sources --

def normalize_entry(value, source):
    """A registry entry or payload identity as a dict; (entry, warnings)."""
    warnings = []
    if isinstance(value, str):
        return {"name": value}, warnings
    if not isinstance(value, dict):
        warnings.append({"source": source, "field": None, "reason": "must be a string or an object"})
        return {}, warnings
    entry = {}
    for key, item in value.items():
        if key in FIELDS:
            entry[key] = item
        else:
            warnings.append({"source": source, "field": key, "reason": "unknown field ignored"})
    return entry, warnings


def load_registry(path, source):
    """Registry map from a bots.json file; ({}, warnings) when missing or invalid."""
    path = Path(path)
    if not path.exists():
        return {}, []
    try:
        value = loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as error:
        return {}, [{"source": source, "field": None, "reason": f"registry unreadable: {type(error).__name__}"}]
    if not isinstance(value, dict):
        return {}, [{"source": source, "field": None, "reason": "registry must be an object"}]
    return value, []


def display_names(registry):
    """{bot id: name} for the legacy display-name consumers."""
    names = {}
    for bot, value in registry.items():
        name = value if isinstance(value, str) else value.get("name") if isinstance(value, dict) else None
        if isinstance(name, str):
            try:
                names[bot] = validate_name(name)
            except IdentityIssue:
                continue
    return names


def resolve_identity(bot, payload_identity=None, *, template_root=None, data_dir=None,
                     user_registry=None, shipped_registry=None, has_payload_identity=None,
                     template_identity=None):
    """Resolve the identity of one run.

    Returns {"name", "initials", "avatar", "shape", "color", "accent",
    "accent_value", "accent_source", "accent_fallback", "warnings"} where
    avatar is a load_avatar() dict or None, shape/color a known name or None,
    accent the per-theme token map or None and accent_source "accent",
    "avatar_color" or None.
    """
    warnings = []
    if user_registry is None:
        user_registry = {}
        if data_dir is not None:
            user_registry, found = load_registry(Path(data_dir) / "bots.json", "user")
            warnings += found
    if shipped_registry is None:
        shipped_registry, found = load_registry(SHIPPED_REGISTRY, "shipped")
        warnings += found
    if has_payload_identity is None:
        has_payload_identity = payload_identity is not None
    sources = []
    if has_payload_identity:
        if isinstance(payload_identity, dict):
            entry, found = normalize_entry(payload_identity, "payload")
            warnings += found
        else:
            entry = {}
            warnings.append({"source": "payload", "field": None, "reason": "identity must be an object"})
        sources.append(("payload", entry, template_root))
    for source, registry, base in (
        ("user", user_registry, data_dir),
        ("shipped", shipped_registry, SHIPPED_REGISTRY.parent),
    ):
        if bot in registry:
            entry, found = normalize_entry(registry[bot], source)
            warnings += found
            sources.append((source, entry, base))

    chosen = {}
    for field in FIELDS:
        if field in AVATAR_FIELDS:
            continue
        for source, entry, base in sources:
            if field not in entry:
                continue
            try:
                chosen[field] = _validate_field(field, entry[field], base, data_dir,
                                                template_root=template_root,
                                                template_identity=template_identity)
            except Omitted:
                continue
            except IdentityIssue as issue:
                warnings.append({"source": source, "field": field, "reason": str(issue)})
                continue
            break
    for source, entry, base in sources:
        stated, values = False, {}
        for field in AVATAR_FIELDS:
            if field not in entry:
                continue
            try:
                values[field] = _validate_field(field, entry[field], base, data_dir,
                                                template_root=template_root,
                                                template_identity=template_identity)
            except Omitted:
                stated = True
                continue
            except IdentityIssue as issue:
                warnings.append({"source": source, "field": field, "reason": str(issue)})
                continue
            stated = True
            if field in ENUM_FIELDS and values[field] is None:
                warnings.append({"source": source, "field": field, "reason": UNKNOWN_REASON[field]})
        if stated:
            chosen.update(values)
            break

    name = chosen.get("name", bot)
    accent = chosen.get("accent")
    color = chosen.get("avatar_color")
    tokens, fallback, accent_source = None, [], None
    if accent is not None:
        accent_source = "accent"
        tokens, fallback, failures = theme_accents(accent)
        for theme in fallback:
            warnings.append({
                "source": "accent",
                "field": "accent",
                "reason": f"contrast too low in {theme} theme; default accent used",
                "theme": theme,
                "failed": failures[theme],
            })
    elif color is not None:
        # the named colour seeds the accent; a theme that fails its checks
        # keeps the default accent (recorded, not a warning: nothing was asked)
        accent_source = "avatar_color"
        tokens, fallback, _ = theme_accents({theme: avatar_fill(color, theme) for theme in THEMES})
    if len(fallback) == len(THEMES):
        tokens = None
    return {
        "name": name,
        "initials": initials(name),
        "avatar": chosen.get("avatar"),
        "shape": chosen.get("avatar_shape"),
        "color": color,
        "accent_value": accent,
        "accent_source": accent_source,
        "accent": tokens,
        "accent_fallback": fallback,
        "warnings": warnings,
    }


def _validate_field(field, value, base, data_dir, *, template_root=None, template_identity=None):
    if field == "name":
        return validate_name(value)
    if field == "accent":
        return validate_accent(value)
    if field in ENUM_FIELDS:
        return validate_enum(field, value)
    if isinstance(value, str) and not value.strip():
        raise Omitted()
    return load_avatar(value, base, data_dir, template_root=template_root,
                       template_identity=template_identity)


def registry_warnings(data_dir=None):
    """doctor: every invalid or unknown field of the user and shipped registries."""
    found = []
    registries = []
    if data_dir is not None:
        registries.append(("user", Path(data_dir) / "bots.json", Path(data_dir)))
    registries.append(("shipped", SHIPPED_REGISTRY, SHIPPED_REGISTRY.parent))
    for source, path, base in registries:
        registry, problems = load_registry(path, source)
        found += [f"{source} bots.json: {item['reason']}" for item in problems]
        for bot, value in registry.items():
            entry, problems = normalize_entry(value, source)
            found += [
                f"{source} bots.json {bot}: {item['field'] or 'entry'} {item['reason']}"
                for item in problems
            ]
            for field in FIELDS:
                if field not in entry:
                    continue
                try:
                    if _validate_field(field, entry[field], base, data_dir) is None:
                        found.append(f"{source} bots.json {bot}: {field} {UNKNOWN_REASON[field]}")
                except Omitted:
                    continue
                except IdentityIssue as issue:
                    found.append(f"{source} bots.json {bot}: {field} {issue}")
    return found


def public_identity(identity, *, with_accent):
    """The page-facing identity: avatar as a same-origin URL, shape and colour
    names (the page draws them from the core set; an image wins), accent only
    for the active run."""
    avatar = identity.get("avatar")
    value = {
        "name": identity["name"],
        "initials": identity["initials"],
        "avatar": f"/avatar/{avatar['sha256']}" if avatar else None,
        "shape": identity.get("shape"),
        "color": identity.get("color"),
    }
    if with_accent:
        value["accent"] = identity.get("accent")
        value["accent_fallback"] = list(identity.get("accent_fallback", []))
    return value
