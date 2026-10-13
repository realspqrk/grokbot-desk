"""Generator (py -3 tools/dev/gen-preview-post-expect.py) for fixtures/expect/*.json of preview-post.

Copies are the composed strings by the template rule (variant text or text,
plus a blank line and the platform's hashtags (variant hashtags or hashtags)
when hashtag_mode is append; NFC).
Counters are derived independently of count.js for fixtures whose composed
text is plain ASCII without URLs: every code point then weighs 1 on X, and
the code-point platforms count code points. A fixture whose X weight is not
its length (CJK, emoji, a URL) takes its counters from count.js itself,
through Node (`counted_by_count_js`)."""
import json
import subprocess
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIX = ROOT / "templates" / "builtin" / "preview-post" / "fixtures"
EXP = FIX / "expect"
LIMITS = {"x": 25000, "linkedin": 3000, "instagram": 2200, "facebook": 63206}
INSTAGRAM_HASHTAGS = 5
# One platform tab at a time: overflow menu, then per tab. Auto: approve, the
# panel's three copy icons, back to the tablist, ArrowRight to the next tab.
# Manual (copies first): the three copy icons and copy image, then "Posted"
# and back ("Show in folder" is in the overflow menu). On the last (auto) tab
# on through the copies and the
# alternative to the submit button.
AUTO_TAB = (
    {"press": "Tab"}, {"press": "Space"}, {"repeat": 3, "press": "Tab"},
    {"repeat": 4, "press": "Shift+Tab"}, {"press": "ArrowRight"},
)
MANUAL_TAB = (
    {"repeat": 5, "press": "Tab"}, {"press": "Space"},
    {"repeat": 5, "press": "Shift+Tab"}, {"press": "ArrowRight"},
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
        {"press": "Tab"}, {"press": "Space"}, {"repeat": 5, "press": "Tab"}, {"press": "Enter"},
    ]


def approved_result(data):
    """Every platform ticked: auto ones are the bot's to post, manual ones were
    posted by hand and never reach `platforms`."""
    return {
        "decision": "approve",
        "platforms": [p for p, mode in entries(data) if mode == "auto"],
        "comment": "",
        "per_platform": {
            p: {"mode": mode, "decision": "done" if mode == "manual" else "approved"}
            for p, mode in entries(data)
        },
    }


def load(name):
    return json.loads((FIX / f"{name}.json").read_text(encoding="utf-8"))


def tags(data, p):
    return data.get("variants", {}).get(p, {}).get("hashtags", data.get("hashtags", []))


def composed(data, p):
    text = data.get("variants", {}).get(p, {}).get("text", data["text"])
    if data.get("hashtag_mode", "append") == "append" and tags(data, p):
        text += "\n\n" + " ".join("#" + h for h in tags(data, p))
    return unicodedata.normalize("NFC", text)


def copies(data):
    out = {}
    for p in ids(data):
        out[f"{p}-text"] = composed(data, p)
        if tags(data, p):
            out[f"{p}-hashtags"] = " ".join("#" + h for h in tags(data, p))
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
            n = len(tags(data, p)) if data.get("hashtag_mode", "append") == "append" else 0
            out["instagram-hashtags"] = {"count": n, "limit": INSTAGRAM_HASHTAGS, "over": n > INSTAGRAM_HASHTAGS}
        if p == "linkedin" and data.get("first_comment"):
            n = len(data["first_comment"])
            out["linkedin-comment"] = {"count": n, "limit": 1250, "over": n > 1250}
    return out


COUNT_JS = """
const C = require(process.argv[1]);
const jobs = JSON.parse(require('fs').readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(jobs.map(([text, p]) => C.count(text, p))));
"""


def counted_by_count_js(data):
    """The counters as count.js reports them (Node runs core/static/count.js)."""
    jobs = [[composed(data, p), p] for p in ids(data)]
    script = ROOT / "core" / "static" / "count.js"
    out = subprocess.run(
        ["node", "-e", COUNT_JS, str(script)], input=json.dumps(jobs),
        capture_output=True, text=True, encoding="utf-8", check=True, timeout=60,
    ).stdout
    result = {}
    for p, res in zip(ids(data), json.loads(out)):
        result[p] = {"count": res["count"], "limit": res["limit"], "over": res["over"]}
        if p == "instagram":
            n = res["hashtags"]
            result["instagram-hashtags"] = {"count": n, "limit": res["hashtagLimit"], "over": n > res["hashtagLimit"]}
    return result


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
for name in ("edge-x-limit", "edge-x-long"):
    data = load(name)
    write(f"{name}.json", {"copies": copies(data), "counters": counters(data)})
for name in ("edge-no-image", "edge-max"):
    write(f"{name}.json", {"copies": copies(load(name)), "counters": {}})
quote = load("quote-video")
write("quote-video.json", {"copies": copies(quote), "counters": counters(quote)})
mixed = load("mixed-image")
write("mixed-image.json", {"copies": copies(mixed), "counters": counters(mixed)})
cjk = load("edge-x-cjk")
write("edge-x-cjk.json", {"copies": copies(cjk), "counters": counted_by_count_js(cjk)})
print("ok")
