"""Generate core/static/avatar-shapes.json: the fixed set of shape avatars.

Usage: py -3 tools/dev/make-avatar-shapes.py [out-file]

Each shape is our own drawing, built from simple geometry (superellipse,
circle, rotated egg, circle with a rounded tip, rounded hexagon, rounded
rectangle) with two eye holes; no third-party asset is used. Output: one SVG path per shape in a 48x48 box, drawn with
fill-rule evenodd so the eyes are holes that show the surface behind the
avatar. Pure standard library.
"""
import json
import math
import sys
from pathlib import Path

BOX = 48
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "core" / "static" / "avatar-shapes.json"
# the named fills; tokens.css defines --rs-avatar-<name> per theme
COLORS = ("blue", "orange", "yellow", "magenta", "red", "violet", "black", "green", "gray")


def _fmt(value):
    text = f"{value:.2f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


# ------------------------------------------------------------- outlines --
# Each outline is a dense closed polygon in arbitrary units; place() scales it
# into the box. Angles are screen angles (0 = right, 90 = down).

def superellipse(n, count=360):
    points = []
    for index in range(count):
        t = 2 * math.pi * index / count
        c, s = math.cos(t), math.sin(t)
        points.append((math.copysign(abs(c) ** (2 / n), c), math.copysign(abs(s) ** (2 / n), s)))
    return points


def wobble_circle(amount, phase, count=360):
    """A circle whose radius swells by +-amount twice around: a soft lump."""
    points = []
    for index in range(count):
        t = 2 * math.pi * index / count
        radius = 1 + amount * math.cos(2 * t + phase)
        points.append((radius * math.cos(t), radius * math.sin(t)))
    return points


def egg(ratio, rotation, bulge, count=360):
    """An ellipse (ratio = width/height) fuller on one end, then rotated."""
    rot = math.radians(rotation)
    points = []
    for index in range(count):
        t = 2 * math.pi * index / count
        x = ratio * math.cos(t) * (1 + bulge * math.sin(t))
        y = math.sin(t)
        points.append((x * math.cos(rot) - y * math.sin(rot), x * math.sin(rot) + y * math.cos(rot)))
    return points


def teardrop(tip_distance, tip_radius, tip_angle, count=360):
    """Unit circle plus a tip: two tangent lines towards a point tip_distance
    away, the point rounded with tip_radius."""
    t = math.radians(tip_angle)
    half = math.asin(1 / tip_distance)
    beta = math.pi / 2 - half
    centre = tip_distance - tip_radius / math.sin(half)
    points = []
    start, end = t + beta, t - beta + 2 * math.pi
    for index in range(count):
        a = start + (end - start) * index / (count - 1)
        points.append((math.cos(a), math.sin(a)))
    fx, fy = centre * math.cos(t), centre * math.sin(t)
    steps = count // 6
    for index in range(steps):
        a = (t - beta) + 2 * beta * index / (steps - 1)
        points.append((fx + tip_radius * math.cos(a), fy + tip_radius * math.sin(a)))
    return points


def rounded_polygon(corners, radius, rotation, count=60):
    """Regular polygon (pointy top) with circular corners of the given radius."""
    points = []
    step = 360 / corners
    inset = 1 - radius / math.sin(math.radians(90 - step / 2))
    for k in range(corners):
        angle = math.radians(-90 + step * k + rotation)
        cx, cy = inset * math.cos(angle), inset * math.sin(angle)
        for index in range(count):
            a = angle - math.radians(step / 2) + math.radians(step) * index / (count - 1)
            points.append((cx + radius * math.cos(a), cy + radius * math.sin(a)))
    return points


def rounded_rect(width, height, radius, count=60):
    points = []
    centres = ((width / 2 - radius, -height / 2 + radius), (width / 2 - radius, height / 2 - radius),
               (-width / 2 + radius, height / 2 - radius), (-width / 2 + radius, -height / 2 + radius))
    for k, (cx, cy) in enumerate(centres):
        for index in range(count):
            a = math.radians(-90 + 90 * k + 90 * index / (count - 1))
            points.append((cx + radius * math.cos(a), cy + radius * math.sin(a)))
    return points


# -------------------------------------------------------------- to path --

def resample(points, count):
    """count points at equal arc length along the closed polygon."""
    closed = points + [points[0]]
    lengths = [0.0]
    for (x0, y0), (x1, y1) in zip(closed, closed[1:]):
        lengths.append(lengths[-1] + math.hypot(x1 - x0, y1 - y0))
    total = lengths[-1]
    out, segment = [], 0
    for index in range(count):
        target = total * index / count
        while lengths[segment + 1] < target:
            segment += 1
        span = lengths[segment + 1] - lengths[segment] or 1
        f = (target - lengths[segment]) / span
        (x0, y0), (x1, y1) = closed[segment], closed[segment + 1]
        out.append((x0 + (x1 - x0) * f, y0 + (y1 - y0) * f))
    return out


def smooth_path(points):
    """Closed Catmull-Rom spline through the points as cubic Beziers."""
    n = len(points)
    parts = [f"M{_fmt(points[0][0])} {_fmt(points[0][1])}"]
    for i in range(n):
        p0, p1, p2, p3 = points[i - 1], points[i], points[(i + 1) % n], points[(i + 2) % n]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        parts.append("C" + " ".join(_fmt(v) for v in (*c1, *c2, *p2)))
    return "".join(parts) + "Z"


def place(points, width, height):
    """Scale uniformly so the outline is width x height (one of them binding), centred."""
    xs = [x for x, _ in points]
    ys = [y for _, y in points]
    scale = min(width / (max(xs) - min(xs)), height / (max(ys) - min(ys)))
    ox = BOX / 2 - (max(xs) + min(xs)) / 2 * scale
    oy = BOX / 2 - (max(ys) + min(ys)) / 2 * scale
    placed = [(x * scale + ox, y * scale + oy) for x, y in points]
    xs = [x for x, _ in placed]
    ys = [y for _, y in placed]
    return placed, (min(xs), min(ys), max(xs), max(ys))


# ----------------------------------------------------------------- eyes --

def eye_ellipse(cx, cy, major, minor, angle):
    """Ellipse as two arcs; angle = direction of the long axis."""
    a = math.radians(angle)
    x1, y1 = cx + major * math.cos(a), cy + major * math.sin(a)
    x2, y2 = cx - major * math.cos(a), cy - major * math.sin(a)
    r = f"{_fmt(major)} {_fmt(minor)} {_fmt(angle)}"
    return (f"M{_fmt(x1)} {_fmt(y1)}A{r} 1 0 {_fmt(x2)} {_fmt(y2)}"
            f"A{r} 1 0 {_fmt(x1)} {_fmt(y1)}Z")


def eye_capsule(cx, cy, width, height):
    """Upright capsule (stadium)."""
    r = width / 2
    top, bottom = cy - height / 2 + r, cy + height / 2 - r
    return (f"M{_fmt(cx - r)} {_fmt(top)}A{_fmt(r)} {_fmt(r)} 0 0 1 {_fmt(cx + r)} {_fmt(top)}"
            f"V{_fmt(bottom)}A{_fmt(r)} {_fmt(r)} 0 0 1 {_fmt(cx - r)} {_fmt(bottom)}Z")


def eyes(bbox, specs):
    """Eye specs relative to the outline's bounding box: (kind, cx, cy, a, b[, angle]);
    x and sizes in box widths, y in box heights."""
    x0, y0, x1, y1 = bbox
    w, h = x1 - x0, y1 - y0
    out = []
    for kind, cx, cy, a, b, *rest in specs:
        px, py = x0 + cx * w, y0 + cy * h
        if kind == "capsule":
            out.append(eye_capsule(px, py, a * w, b * w))
        else:
            out.append(eye_ellipse(px, py, a * w, b * w, rest[0]))
    return "".join(out)


# A sideways look: the near eye is wider than the far one; both lean the
# same way. Values are fractions of the outline's bounding box.
LOOK_UP_RIGHT = (("ellipse", 0.55, 0.335, 0.148, 0.062, 56), ("ellipse", 0.785, 0.225, 0.146, 0.05, 56))

SHAPES = {
    # soft round lump, eyes up and to the right
    "blob": (wobble_circle(0.012, 0.6), 45, 45, 36, LOOK_UP_RIGHT),
    # rounded square, big upright capsule eyes in the middle
    "squircle": (superellipse(3), 44.5, 44.5, 40,
                 (("capsule", 0.35, 0.555, 0.2, 0.4), ("capsule", 0.65, 0.555, 0.2, 0.4))),
    # wide tilted egg
    "pebble": (egg(1.07, -36, 0.08), 46.5, 43.75, 40,
               (("ellipse", 0.59, 0.35, 0.145, 0.06, 66), ("ellipse", 0.805, 0.28, 0.146, 0.05, 66))),
    # rounded hexagon, round eyes low and to the left
    "hex": (rounded_polygon(6, 0.35, 8), 44.2, 47, 48,
            (("ellipse", 0.245, 0.55, 0.15, 0.135, 20), ("ellipse", 0.615, 0.6, 0.15, 0.135, 13))),
    # round body with one distinct, barely rounded tip up and to the left
    # (more nodes so the spline keeps the corner)
    "teardrop": (teardrop(1.33, 0.1, -118), 41.5, 47, 96,
                 (("ellipse", 0.6, 0.395, 0.15, 0.062, 65), ("ellipse", 0.815, 0.35, 0.146, 0.05, 67))),
    # upright rounded tablet, eyes up and to the right
    "tablet": (rounded_rect(0.8, 1, 0.27), 37.5, 46, 40,
               (("ellipse", 0.56, 0.3, 0.16, 0.07, 62), ("ellipse", 0.81, 0.235, 0.15, 0.055, 62))),
}


def build():
    shapes = {}
    for name, (outline, width, height, nodes, eye_specs) in SHAPES.items():
        placed, bbox = place(outline, width, height)
        shapes[name] = smooth_path(resample(placed, nodes)) + eyes(bbox, eye_specs)
    return {
        "view_box": f"0 0 {BOX} {BOX}",
        "fill_rule": "evenodd",
        "shapes": shapes,
        "colors": list(COLORS),
    }


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else OUT
    out.write_text(json.dumps(build(), indent=1) + "\n", encoding="utf-8")
    print(out)


if __name__ == "__main__":
    main()
