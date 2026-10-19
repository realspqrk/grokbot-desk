"""Whether an auto post may go out on a platform, checked on the server.

The page counts with core/static/count.js and the rules in platforms.json.
The server mirrors them for the result check: code-point platforms count
exactly; Instagram's hashtags and X's weighted count use a floor, so the
server never counts more than the page does. A post the page lets the
person approve is never refused here; one clearly over a limit is.

X floor: a whitespace-separated word that holds a "." may be a URL (23 on
X however long), so it adds nothing; in other words every code point weighs
what count.js gives it, except those that can be part of an emoji entity
(entity weight 2), which add nothing either. Hashtags inside such a word are
not counted (the page skips hashtags inside URLs).
"""
import json
import re
import unicodedata
from pathlib import Path


PLATFORMS = json.loads(
    (Path(__file__).resolve().parent / "static" / "platforms.json").read_text(encoding="utf-8")
)["platforms"]
# what a URL never spans (count.js domain and path characters exclude them)
SPACES = "\t\n\x0b\x0c\r \x85\xa0 ᠎ -     　"
SPLIT_RE = re.compile(f"([{SPACES}]+)")
WORD_RE = re.compile(f"[^{SPACES}]+")
ZWJ = 0x200D


def _emoji_part(cp):
    """A code point that can sit inside an emoji entity of the pinned regex."""
    return (
        0x2000 <= cp <= 0x2BFF or cp in (0x3030, 0x303D, 0x3297, 0x3299, 0xE50A)
        or 0xFE00 <= cp <= 0xFE0F or 0x1F000 <= cp <= 0x1FBFF or 0xE0000 <= cp <= 0xE007F
    )


def _weight_floor(cp, rules):
    if cp == ZWJ:
        return 0
    for low, high, weight in rules["ranges"]:
        if low <= cp <= high:
            return weight
    return 0 if _emoji_part(cp) else rules["default_weight"]


def x_weight_floor(text):
    """At most X's weighted count of the (NFC) text."""
    rules = PLATFORMS["x"]
    total = 0
    for part in SPLIT_RE.split(unicodedata.normalize("NFC", text)):
        if "." in part:
            continue
        total += sum(_weight_floor(ord(char), rules) for char in part)
    return total


def _word_char(char):
    return unicodedata.category(char)[0] in "LMN" or char == "_"


def _tag_letter(char):
    return unicodedata.category(char)[0] == "L" or char == "_"


def hashtag_tags(text):
    """The counted hashtag bodies, lower-cased (count.js hashtagTags, minus
    any inside a word that may be a URL)."""
    dotted = [match.span() for match in WORD_RE.finditer(text) if "." in match.group()]
    tags, at, size = [], 0, len(text)
    while at < size:
        if text[at] != "#":
            at += 1
            continue
        before = text[at - 1] if at else ""
        run_end = at
        while run_end < size and text[run_end] == "#":
            run_end += 1
        body_end = run_end
        while body_end < size and _word_char(text[body_end]):
            body_end += 1
        body = text[run_end:body_end]
        if (
            not (before and (_word_char(before) or before in "&#/"))
            and any(_tag_letter(char) for char in body)
            and not any(start <= at < end for start, end in dotted)
        ):
            tags.append(body.lower())
        at = run_end
    return tags


def _variant(block, platform):
    return (block.get("variants") or {}).get(platform) or {}


def composed(block, platform):
    """The platform's text, plus a blank line and its hashtags in append mode."""
    tags = _variant(block, platform).get("hashtags", block.get("hashtags") or [])
    text = _variant(block, platform).get("text", block["text"])
    if block.get("hashtag_mode", "append") == "append" and tags:
        text += "\n\n" + " ".join("#" + tag for tag in tags)
    return unicodedata.normalize("NFC", text), tags


def problems(block, platform):
    """Why an auto post cannot go out on this platform (empty: it can)."""
    rules = PLATFORMS[platform]
    text, tags = composed(block, platform)
    found = []
    count = x_weight_floor(text) if rules["unit"] == "weighted" else len(text)
    if count > rules["limit"]:
        found.append(f"over its {rules['limit']} character limit")
    if "hashtag_limit" in rules:
        counted = text
        if block.get("hashtag_mode", "append") != "append":
            carried = hashtag_tags(text)
            extra = [tag for tag in tags if unicodedata.normalize("NFC", tag).lower() not in carried]
            if extra:
                counted = text + "\n\n" + " ".join("#" + tag for tag in extra)
        if len(hashtag_tags(counted)) > rules["hashtag_limit"]:
            found.append(f"more than {rules['hashtag_limit']} hashtags")
    if platform == "instagram" and not (block.get("image") or block.get("video")):
        found.append("needs an image or a video")
    return found
