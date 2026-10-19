"""Colour maths for the design tokens: #rrggbb and oklch() to sRGB, WCAG contrast.

tokens.css writes the desk colours as ``oklch(L C H)`` (L 0-1 or a
percentage, C >= 0, H in degrees). They are read through Björn Ottosson's
OKLab matrices. A colour outside sRGB keeps its lightness and hue and loses
chroma until it fits (binary search), then the channels are clipped by at
most the search tolerance. Alpha is not accepted: a contrast check needs an
opaque colour.
"""
import math
import re

HEX_RE = re.compile(r"#([0-9a-fA-F]{6})")
_NUMBER = r"([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)"
OKLCH_RE = re.compile(
    rf"oklch\(\s*{_NUMBER}(%?)\s+{_NUMBER}\s+{_NUMBER}(?:deg)?\s*\)", re.IGNORECASE
)
GAMUT_EPSILON = 1e-4


def _encode(channel):
    if channel <= 0.0031308:
        return 12.92 * channel
    return 1.055 * channel ** (1 / 2.4) - 0.055


def _decode(channel):
    if channel <= 0.04045:
        return channel / 12.92
    return ((channel + 0.055) / 1.055) ** 2.4


def oklab_to_linear(lightness, a, b):
    l_ = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m_ = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s_ = (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3
    return (
        4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
        -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
        -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_,
    )


def _linear_oklch(lightness, chroma, hue):
    angle = math.radians(hue)
    return oklab_to_linear(lightness, chroma * math.cos(angle), chroma * math.sin(angle))


def _fits(linear, epsilon=GAMUT_EPSILON):
    return all(-epsilon <= channel <= 1 + epsilon for channel in linear)


def oklch_to_srgb(lightness, chroma, hue):
    """Gamma-encoded sRGB floats 0-1; out-of-gamut chroma is reduced at fixed L and H."""
    linear = _linear_oklch(lightness, chroma, hue)
    if not _fits(linear):
        low, high = 0.0, chroma
        for _ in range(40):
            middle = (low + high) / 2
            if _fits(_linear_oklch(lightness, middle, hue)):
                low = middle
            else:
                high = middle
        linear = _linear_oklch(lightness, low, hue)
    return tuple(_encode(min(1.0, max(0.0, channel))) for channel in linear)


def _oklch_numbers(text):
    match = OKLCH_RE.fullmatch(text.strip())
    if not match:
        return None
    lightness, percent, chroma, hue = match.groups()
    lightness = float(lightness) / (100 if percent else 1)
    chroma, hue = float(chroma), float(hue)
    if not 0 <= lightness <= 1 or chroma < 0:
        raise ValueError(f"oklch() out of range: {text!r}")
    return lightness, chroma, hue


def parse(text):
    """sRGB floats 0-1 of an opaque ``#rrggbb`` or ``oklch(L C H)``."""
    if not isinstance(text, str):
        raise ValueError(f"expected a colour string, got {text!r}")
    value = text.strip()
    match = HEX_RE.fullmatch(value)
    if match:
        number = match.group(1)
        return tuple(int(number[index:index + 2], 16) / 255 for index in (0, 2, 4))
    numbers = _oklch_numbers(value)
    if numbers is None:
        raise ValueError(f"expected #rrggbb or oklch(L C H), got {text!r}")
    return oklch_to_srgb(*numbers)


def in_gamut(text, epsilon=1e-3):
    """True for hex, and for oklch() that needs no chroma reduction."""
    numbers = _oklch_numbers(text)
    if numbers is None:
        parse(text)
        return True
    return _fits(_linear_oklch(*numbers), epsilon)


def to_hex(value):
    rgb = parse(value) if isinstance(value, str) else value
    return "#" + "".join(f"{max(0, min(255, round(channel * 255))):02x}" for channel in rgb)


def oklab(value):
    """(L, a, b) of a colour string or sRGB floats."""
    rgb = parse(value) if isinstance(value, str) else value
    red, green, blue = (_decode(channel) for channel in rgb)
    l_ = (0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue) ** (1 / 3)
    m_ = (0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue) ** (1 / 3)
    s_ = (0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue) ** (1 / 3)
    return (
        0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    )


def delta_e_ok(first, second):
    """Euclidean distance in OKLab (deltaE OK)."""
    return math.dist(oklab(first), oklab(second))


def luminance(value):
    rgb = parse(value) if isinstance(value, str) else value
    red, green, blue = (_decode(channel) for channel in rgb)
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def contrast(first, second):
    bright, dark = sorted((luminance(first), luminance(second)), reverse=True)
    return (bright + 0.05) / (dark + 0.05)
