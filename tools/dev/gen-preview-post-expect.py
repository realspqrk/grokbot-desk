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
# One platform tab at a time: overflow menu, then per tab. Auto: approve, the
# panel's three copy icons, back to the tablist, ArrowRight to the next tab.
# Manual (copies first): the three copy icons, copy image and its folder, then
# "Mark as posted" and back. On the last (auto) tab on through discard and the
# alternative to the submit button.
AUTO_TAB = (
    {"press": "Tab"}, {"press": "Space"}, {"repeat": 3, "press": "Tab"},
    {"repeat": 4, "press": "Shift+Tab"}, {"press": "ArrowRight"},
)
MANUAL_TAB = (
    {"repeat": 6, "press": "Tab"}, {"press": "Space"},
    {"repeat": 6, "press": "Shift+Tab"}, {"press": "ArrowRight"},
)


def entries(data):
    """The payload platforms as (id, mode): a plain id is auto."""
    return [
        (item, "auto") if isinstance(item, str) else (item["platform"], item.get("mode", "auto"))
        for item in data["platforms"]
    ]


def ids(data):
    return [platform for platform, _ in entries(data)]


def keyboard_path(data):
    tabs = entries(data)
    assert tabs[-1][1] == "auto"
    return [
        {"repeat": 2, "press": "Tab"},
        *[step for _, mode in tabs[:-1] for step in (MANUAL_TAB if mode == "manual" else AUTO_TAB)],
        {"press": "Tab"}, {"press": "Space"}, {"repeat": 6, "press": "Tab"}, {"press": "Enter"},
    ]


def approved_result(data):
    """Every platform ticked: auto ones are the bot's to post, manual ones were
    posted by hand and never reach `platforms`."""
    return {
        "decision": "approve",
        "platforms": [p for p, mode in entries(data) if mode == "auto"],
        "comment": "",
        "per_platform": {
            p: {"mode": mode, "decision": "posted_manually" if mode == "manual" else "approved"}
            for p, mode in entries(data)
        },
    }


def load(name):
    return json.loads((FIX / f"{name}.json").read_text(encoding="utf-8"))


def composed(data, p):
    text = data.get("variants", {}).get(p, {}).get("text", data["text"])
    if data.get("hashtag_mode", "append") == "append" and data.get("hashtags"):
        text += "\n\n" + " ".join("#" + h for h in data["hashtags"])
    return unicodedata.normalize("NFC", text)


def copies(data):
    out = {}
    for p in ids(data):
        out[f"{p}-text"] = composed(data, p)
        if data.get("hashtags"):
            out[f"{p}-hashtags"] = " ".join("#" + h for h in data["hashtags"])
        if data.get("first_comment"):
            out[f"{p}-comment"] = data["first_comment"]
    return out


def counters(data):
    out = {}
    for p in ids(data):
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
        *[{"click": f"#{kind}-{p}"} for p in ids(golden) for kind in ("tab", "approve")][1:],
        {"press": "Control+Enter"},
    ],
    "keyboard": keyboard_path(golden),
    "result": approved_result(golden),
})
limit = load("edge-x-limit")
write("edge-x-limit.json", {"copies": copies(limit), "counters": counters(limit)})
for name in ("edge-no-image", "edge-max"):
    write(f"{name}.json", {"copies": copies(load(name)), "counters": {}})
print("ok")
