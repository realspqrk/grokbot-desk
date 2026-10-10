"""Generator (py -3 tools/dev/gen-preview-post-expect.py) for fixtures/expect/*.json of preview-post.

Copies are the composed strings by the template rule (variant text or text,
plus a blank line and the hashtags when hashtag_mode is append; NFC).
Counters are derived independently of count.js and only for fixtures whose
composed text is plain ASCII without URLs: every code point then weighs 1 on
X, and the code-point platforms count code points."""
import json
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIX = ROOT / "templates" / "builtin" / "preview-post" / "fixtures"
EXP = FIX / "expect"
LIMITS = {"x": 280, "linkedin": 3000, "instagram": 2200, "facebook": 63206}
# One platform tab at a time: overflow menu, tab, approve, the panel's three
# copy icons, back to the tablist, ArrowRight to the next tab; on the last tab
# on through discard and the alternative to the submit button.
GOLDEN_KEYBOARD_PATH = [
    {"repeat": 2, "press": "Tab"},
    *[step for _ in range(3) for step in (
        {"press": "Tab"}, {"press": "Space"}, {"repeat": 3, "press": "Tab"},
        {"repeat": 4, "press": "Shift+Tab"}, {"press": "ArrowRight"},
    )],
    {"press": "Tab"}, {"press": "Space"}, {"repeat": 6, "press": "Tab"}, {"press": "Enter"},
]


def load(name):
    return json.loads((FIX / f"{name}.json").read_text(encoding="utf-8"))


def composed(data, p):
    text = data.get("variants", {}).get(p, {}).get("text", data["text"])
    if data.get("hashtag_mode", "append") == "append" and data.get("hashtags"):
        text += "\n\n" + " ".join("#" + h for h in data["hashtags"])
    return unicodedata.normalize("NFC", text)


def copies(data):
    out = {}
    for p in data["platforms"]:
        out[f"{p}-text"] = composed(data, p)
        if data.get("hashtags"):
            out[f"{p}-hashtags"] = " ".join("#" + h for h in data["hashtags"])
        if data.get("first_comment"):
            out[f"{p}-comment"] = data["first_comment"]
    return out


def counters(data):
    out = {}
    for p in data["platforms"]:
        text = composed(data, p)
        assert text.isascii() and "://" not in text and ".example" not in text, p
        out[p] = {"count": len(text), "limit": LIMITS[p], "over": len(text) > LIMITS[p]}
        if p == "instagram":
            tags = len(data.get("hashtags", [])) if data.get("hashtag_mode", "append") == "append" else 0
            out["instagram-hashtags"] = {"count": tags, "limit": 30, "over": tags > 30}
        if p == "linkedin" and data.get("first_comment"):
            n = len(data["first_comment"])
            out["linkedin-comment"] = {"count": n, "limit": 1250, "over": n > 1250}
    return out


def write(name, value):
    (EXP / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


golden = load("golden")
write("golden.json", {
    "copies": copies(golden),
    "counters": counters(golden),
    "flow": [
        *[{"click": f"#{kind}-{p}"} for p in golden["platforms"] for kind in ("tab", "approve")][1:],
        {"press": "Control+Enter"},
    ],
    "keyboard": GOLDEN_KEYBOARD_PATH,
    "result": {"decision": "approve", "platforms": golden["platforms"], "comment": ""},
})
limit = load("edge-x-limit")
write("edge-x-limit.json", {"copies": copies(limit), "counters": counters(limit)})
for name in ("edge-no-image", "edge-max"):
    write(f"{name}.json", {"copies": copies(load(name)), "counters": {}})
print("ok")
