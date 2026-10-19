"""payload@2 blocks and the decision contract of `ask`.

A report is a list of blocks. Content blocks mix freely; at most one input
block (decide, pick, post) asks the person for answers, and which one is
allowed follows from the report's `ask`. Block shapes live in
blocks.schema.json (restricted JSON Schema, core/schema.py); the rules a
schema cannot state are checked here and raise EnvelopeError(pointer,
message) like every other payload error.
"""
import json
import math
import re
from datetime import date
from pathlib import Path

from .schema import SchemaError, _pointer, validate


HERE = Path(__file__).resolve().parent
I18N = HERE / "i18n"
ASKS = ("read", "review", "approve", "do", "choose")
CONTENT_TYPES = ("text", "stats", "table", "chart", "facts", "checks", "media", "copy")
INPUT_TYPES = ("decide", "pick", "post")
BLOCK_TYPES = CONTENT_TYPES + INPUT_TYPES
BLOCK_SCHEMAS = json.loads((HERE / "blocks.schema.json").read_text(encoding="utf-8"))
MAX_BLOCKS = 40
# the input block types each ask accepts (the decision contract)
INPUTS = {
    "read": (),
    "review": (),
    "approve": ("decide", "post"),
    "do": ("decide", "post"),
    "choose": ("pick",),
}
# decide rows take their side from ask: the bot's choices or the person's
CHOICES = {"approve": ("approve", "reject", "later"), "do": ("done", "skipped", "later")}
PLATFORM_MODES = {"approve": "auto", "do": "manual"}
# the UI strings a default choice label may show, in every UI language
DEFAULT_LABEL_KEYS = {
    "approve": ("choice_approve",),
    "reject": ("choice_reject",),
    "later": ("choice_later", "choice_defer", "choice_spaeter"),
}
STATES = ("ok", "warn", "fail", "open")
NUMBER_COLUMNS = ("number", "money", "percent", "delta")
MAX_CELL = 500
DATE_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
VIDEO_SUFFIXES = (".mp4", ".webm")
FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
SECTION_RE = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]|$)")


class EnvelopeError(ValueError):
    def __init__(self, pointer, message=None):
        if message is None:
            message, pointer = pointer, ""
        self.pointer = pointer
        self.message = message
        super().__init__(f"{pointer or '/'}: {message}")


def block_id(block, index):
    """The block's id, or b<1-based position> when it has none."""
    given = block.get("id") if isinstance(block, dict) else None
    return given if given is not None else f"b{index + 1}"


def with_ids(blocks):
    """Copies of the blocks with every id filled."""
    return [dict(block, id=block_id(block, index)) for index, block in enumerate(blocks)]


def input_block(payload):
    """The report's input block (decide, pick or post), or None."""
    for block in payload.get("blocks") or []:
        if isinstance(block, dict) and block.get("type") in INPUT_TYPES:
            return block
    return None


def validate_blocks(payload):
    """Every block, its ids and the ask's decision contract. Raises EnvelopeError."""
    ask = payload.get("ask")
    if not isinstance(ask, str) or ask not in ASKS:
        raise EnvelopeError("/ask", "must be one of " + ", ".join(ASKS))
    blocks = payload.get("blocks")
    if not isinstance(blocks, list):
        raise EnvelopeError("/blocks", "expected array")
    if not blocks:
        raise EnvelopeError("/blocks", "must contain at least 1 block")
    if len(blocks) > MAX_BLOCKS:
        raise EnvelopeError("/blocks", f"must contain at most {MAX_BLOCKS} blocks")
    seen = {}
    inputs = []
    for index, block in enumerate(blocks):
        here = _pointer("/blocks", index)
        _check_block(block, here)
        name = block_id(block, index)
        if name in seen:
            where = _pointer(here, "id") if "id" in block else here
            note = "" if "id" in block else " (a block without an id is b<position>)"
            raise EnvelopeError(
                where, f"duplicate block id {name!r}, already used by /blocks/{seen[name]}{note}"
            )
        seen[name] = index
        if block["type"] in INPUT_TYPES:
            inputs.append((index, block))
    _check_contract(payload, ask, inputs)


def _schema_error(error):
    return EnvelopeError(error.pointer, error.message)


def _check_block(block, here):
    if not isinstance(block, dict):
        raise EnvelopeError(here, "must be an object")
    if "type" not in block:
        raise EnvelopeError(_pointer(here, "type"), "required property is missing")
    if not isinstance(block["type"], str) or block["type"] not in BLOCK_TYPES:
        raise EnvelopeError(_pointer(here, "type"), "must be one of " + ", ".join(BLOCK_TYPES))
    if block["type"] == "post":
        _check_platforms_unique(block, here)
    try:
        validate(block, BLOCK_SCHEMAS[block["type"]], here)
    except SchemaError as error:
        raise _schema_error(error) from error
    check = BLOCK_RULES.get(block["type"])
    if check is not None:
        check(block, here)


def _check_platforms_unique(block, here):
    """Before the schema: its oneOf over the two platform forms would name a
    repeated platform as a shape error ("expected object")."""
    platforms = block.get("platforms")
    if not isinstance(platforms, list):
        return
    seen = set()
    for index, entry in enumerate(platforms):
        name = entry.get("platform") if isinstance(entry, dict) else entry
        if not isinstance(name, str):
            continue
        if name in seen:
            raise EnvelopeError(
                _pointer(_pointer(here, "platforms"), index), f"duplicate platform {name!r}"
            )
        seen.add(name)


def _check_contract(payload, ask, inputs):
    allowed = INPUTS[ask]
    for index, block in inputs:
        if block["type"] not in allowed:
            where = _pointer(_pointer("/blocks", index), "type")
            if not allowed:
                raise EnvelopeError(where, f"ask {ask} takes no input block")
            raise EnvelopeError(
                where, f"ask {ask} takes no {block['type']} block (allowed: {', '.join(allowed)})"
            )
    if len(inputs) > 1:
        raise EnvelopeError(
            _pointer("/blocks", inputs[1][0]),
            f"only one input block per report (the first is /blocks/{inputs[0][0]})",
        )
    if not inputs:
        if ask == "approve" and "action" not in payload:
            raise EnvelopeError(
                "/action", "ask approve without an input block needs action (the verb on the primary)"
            )
        if ask == "choose":
            raise EnvelopeError("/blocks", "ask choose needs a pick block")
        return
    index, block = inputs[0]
    here = _pointer("/blocks", index)
    if block["type"] == "decide":
        _check_decide(block, here, ask)
    elif block["type"] == "post":
        _check_post_modes(block, here, ask)


# --- content blocks ---------------------------------------------------------


def _finite_number(value):
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def _real_date(value):
    if not isinstance(value, str) or not DATE_RE.fullmatch(value):
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def _check_cell(value, kind, where):
    if value is None:
        return
    if isinstance(value, str) and len(value) > MAX_CELL:
        raise EnvelopeError(where, f"must be at most {MAX_CELL} characters")
    if kind == "text":
        if not (isinstance(value, str) or _finite_number(value)):
            raise EnvelopeError(where, "must be text, a number or null in a text column")
    elif kind in NUMBER_COLUMNS:
        if not _finite_number(value):
            raise EnvelopeError(where, f"must be a number or null in a {kind} column")
    elif kind == "status":
        if value not in STATES:
            raise EnvelopeError(where, "must be ok, warn, fail, open or null in a status column")
    elif kind == "date":
        if not _real_date(value):
            raise EnvelopeError(where, "must be a real YYYY-MM-DD day or null in a date column")


def _check_table(block, here):
    kinds = {column["key"]: column.get("type", "text") for column in block["columns"]}
    rows = [(_pointer(_pointer(here, "rows"), index), row) for index, row in enumerate(block["rows"])]
    if "total" in block:
        rows.append((_pointer(here, "total"), block["total"]))
    for where, row in rows:
        for key, value in row.items():
            if key not in kinds:
                raise EnvelopeError(_pointer(where, key), "is not a column of this table (columns[].key)")
            _check_cell(value, kinds[key], _pointer(where, key))


def _check_chart(block, here):
    if "orientation" in block and block["kind"] != "bar":
        raise EnvelopeError(_pointer(here, "orientation"), "only applies to a bar chart")
    count = len(block["labels"])
    for index, series in enumerate(block["series"]):
        if len(series["values"]) != count:
            raise EnvelopeError(
                _pointer(_pointer(_pointer(here, "series"), index), "values"),
                f"needs one value per label ({count})",
            )


def _check_media(block, here):
    if "poster" in block and not block["path"].lower().endswith(VIDEO_SUFFIXES):
        raise EnvelopeError(_pointer(here, "poster"), "only a video (.mp4, .webm) takes a poster")


def _check_pick(block, here):
    ids = [option["id"] for option in block["options"]]
    if "suggested" in block and block["suggested"] not in ids:
        raise EnvelopeError(_pointer(here, "suggested"), "must be one of the option ids")


def _check_decide_dates(block, here):
    for index, item in enumerate(block["items"]):
        if "due" in item and not _real_date(item["due"]):
            raise EnvelopeError(
                _pointer(_pointer(_pointer(here, "items"), index), "due"), "must be a real calendar date"
            )


BLOCK_RULES = {
    "table": _check_table,
    "chart": _check_chart,
    "media": _check_media,
    "pick": _check_pick,
    "decide": _check_decide_dates,
}


# --- input blocks under an ask -----------------------------------------------


def _same(text):
    return " ".join(text.split()).casefold()


def _default_labels():
    """The default choice labels in every UI language, per choice value."""
    labels = {value: set() for value in DEFAULT_LABEL_KEYS}
    for path in sorted(I18N.glob("*.json")):
        table = json.loads(path.read_text(encoding="utf-8"))
        for value, keys in DEFAULT_LABEL_KEYS.items():
            for key in keys:
                text = table.get(key)
                if isinstance(text, str):
                    labels[value].add(_same(text))
    return labels


def _check_decide(block, here, ask):
    legal = CHOICES[ask]
    items_at = _pointer(here, "items")
    if ask == "do" and "labels" in block:
        raise EnvelopeError(_pointer(here, "labels"), "ask do: the person's rows take no labels")
    for index, item in enumerate(block["items"]):
        item_at = _pointer(items_at, index)
        if ask == "do" and "labels" in item:
            raise EnvelopeError(_pointer(item_at, "labels"), "ask do: the person's rows take no labels")
        for position, choice in enumerate(item.get("choices", ())):
            if choice not in legal:
                raise EnvelopeError(
                    _pointer(_pointer(item_at, "choices"), position),
                    f"ask {ask} allows {', '.join(legal)}",
                )
    if ask == "approve":
        _check_labels(block, here)


def _check_labels(block, here):
    """Per item, the labels it shows (its own, then the block's, then the
    defaults in every UI language) differ, and no custom label reads like
    another choice's default label: a swap (approve shown as "Reject")
    records the opposite of what the person read."""
    defaults = _default_labels()
    top = block.get("labels", {})
    # a custom label never reads like another choice, shown on an item or not
    items_at = _pointer(here, "items")
    for source, where in [(top, _pointer(here, "labels"))] + [
        (item.get("labels", {}), _pointer(_pointer(items_at, index), "labels"))
        for index, item in enumerate(block["items"])
    ]:
        for value, text in source.items():
            for other in CHOICES["approve"]:
                if other != value and _same(text) in defaults[other]:
                    raise EnvelopeError(_pointer(where, value), f"label reads like the {other} choice")
    for index, item in enumerate(block["items"]):
        item_at = _pointer(_pointer(here, "items"), index)
        own = item.get("labels", {})
        shown = []
        for value in item.get("choices", CHOICES["approve"]):
            for source, where in ((own, _pointer(_pointer(item_at, "labels"), value)),
                                  (top, _pointer(_pointer(here, "labels"), value))):
                if value in source:
                    shown.append((value, {_same(source[value])}, where))
                    break
            else:
                shown.append((value, defaults[value], None))
        for later, (value, labels, where) in enumerate(shown):
            for other, other_labels, other_where in shown[:later]:
                if labels & other_labels:
                    raise EnvelopeError(
                        where or other_where,
                        f"label repeats the {other if where else value} choice of this item",
                    )


def _check_post_modes(block, here, ask):
    want = PLATFORM_MODES[ask]
    for index, entry in enumerate(block["platforms"]):
        where = _pointer(_pointer(here, "platforms"), index)
        mode = entry.get("mode", "auto") if isinstance(entry, dict) else "auto"
        if isinstance(entry, dict) and "mode" in entry:
            where = _pointer(where, "mode")
        if mode != want:
            raise EnvelopeError(where, f"ask {ask} needs every platform {want}")


# --- reply targets -------------------------------------------------------------


def _closes(line, fence):
    text = re.sub(r"^ {0,3}", "", line).rstrip()
    return len(text) >= len(fence) and all(char == fence[0] for char in text)


def sections(md):
    """How many ## and ### headings the text has outside fenced code."""
    count = 0
    fence = None
    for line in md.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if fence is not None:
            if _closes(line, fence):
                fence = None
            continue
        opened = FENCE_RE.match(line)
        if opened:
            fence = opened.group(1)
            continue
        heading = SECTION_RE.match(line)
        if heading and len(heading.group(1)) in (2, 3):
            count += 1
    return count


def anchors(payload):
    """The (block id, key) pairs a reply can point at: decide items, pick
    options, post platforms and section:<n> for the n-th ## or ### heading
    (0-based) of a text block."""
    found = set()
    for index, block in enumerate(payload.get("blocks") or []):
        if not isinstance(block, dict):
            continue
        name = block_id(block, index)
        kind = block.get("type")
        if kind == "decide":
            found.update((name, item["id"]) for item in block.get("items", []))
        elif kind == "pick":
            found.update((name, option["id"]) for option in block.get("options", []))
        elif kind == "post":
            for entry in block.get("platforms", []):
                found.add((name, entry["platform"] if isinstance(entry, dict) else entry))
        elif kind == "text" and isinstance(block.get("md"), str):
            found.update((name, f"section:{n}") for n in range(sections(block["md"])))
    return found
