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
# the review-doc renderer's line patterns (anchors() counts its headings)
FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
HEADING_RE = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*\Z")
SETEXT_RE = re.compile(r"^ {0,3}(?:=+|-+)[ \t]*\Z")
RULE_RE = re.compile(r"^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*\Z")
QUOTE_RE = re.compile(r"^ {0,3}> ?(.*)\Z")
LIST_ITEM_RE = re.compile(r"^( {0,12})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?\Z")
DELIM_ROW_RE = re.compile(r"^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*\Z")


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
    _check_numbers(block, here)
    if block["type"] == "post":
        _check_platforms_unique(block, here)
    try:
        validate(block, BLOCK_SCHEMAS[block["type"]], here)
    except SchemaError as error:
        raise _schema_error(error) from error
    check = BLOCK_RULES.get(block["type"])
    if check is not None:
        check(block, here)


def _check_numbers(value, where):
    """Every number fits a float: JSON integers have no size limit, but a
    browser reads 1e400 as Infinity and math.isfinite raises on them."""
    if isinstance(value, bool):
        return
    if isinstance(value, (int, float)):
        if not _finite_number(value):
            raise EnvelopeError(where, "must be a finite number (too large for a float)")
    elif isinstance(value, dict):
        for key, item in value.items():
            _check_numbers(item, _pointer(where, key))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _check_numbers(item, _pointer(where, index))


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
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:  # an int beyond the float range
        return False


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
    """A plain platform id, or an object without mode, takes the ask's mode
    (auto under approve, manual under do); an explicit other mode is an error."""
    want = PLATFORM_MODES[ask]
    for index, entry in enumerate(block["platforms"]):
        if isinstance(entry, dict) and entry.get("mode", want) != want:
            raise EnvelopeError(
                _pointer(_pointer(_pointer(here, "platforms"), index), "mode"),
                f"ask {ask} needs every platform {want}",
            )


# --- reply targets -------------------------------------------------------------


def _closes(line, fence):
    text = re.sub(r"^ {0,3}", "", line).rstrip()
    return len(text) >= len(fence) and all(char == fence[0] for char in text)


def _split_row(line):
    text = line.strip()
    if text.startswith("|"):
        text = text[1:]
    if text.endswith("|") and text[-2:-1] != "\\":
        text = text[:-1]
    cells, cell, index = [], "", 0
    while index < len(text):
        char = text[index]
        if char == "\\" and text[index + 1:index + 2] == "|":
            cell += "|"
            index += 2
            continue
        if char == "|":
            cells.append(cell.strip())
            cell = ""
        else:
            cell += char
        index += 1
    cells.append(cell.strip())
    return cells


def _starts_block(line):
    return any(pattern.match(line) for pattern in (FENCE_RE, HEADING_RE, RULE_RE, QUOTE_RE, LIST_ITEM_RE))


def _list_end(lines, at):
    """The line after the list that starts at `at` (the renderer's list loop)."""
    first_ordered, outer, count = None, None, 0
    while at < len(lines):
        line = lines[at]
        item = LIST_ITEM_RE.match(line)
        if item and not RULE_RE.match(line):
            ordered = item.group(2)[0].isdigit()
            indent = len(item.group(1))
            if count and indent <= outer and ordered != first_ordered:
                break
            if not count:
                first_ordered = ordered
            outer = indent if outer is None else min(outer, indent)
            count += 1
            at += 1
            continue
        if line.strip() and count and (
            re.match(r"\s{2,}", line) or (lines[at - 1].strip() and not _starts_block(line))
        ):
            at += 1
            continue
        if not line.strip():
            following = at + 1
            while following < len(lines) and not lines[following].strip():
                following += 1
            if following < len(lines) and (
                LIST_ITEM_RE.match(lines[following]) or re.match(r"\s{2,}\S", lines[following])
            ) and not RULE_RE.match(lines[following]):
                at = following
                continue
        break
    return at


def _top_headings(md):
    """(level, text) of every top-level heading, in document order.

    Mirrors the review-doc block parser (core/static md renderer): ATX
    headings, Setext headings (a line of = or - right under paragraph text;
    after a blank line --- is a rule), and lines consumed by fenced code,
    quotes and callouts, lists and tables, which hold no top-level heading.
    """
    lines = md.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    found, para, at = [], [], 0
    while at < len(lines):
        line = lines[at]
        if not line.strip():
            para = []
            at += 1
            continue
        if para and SETEXT_RE.match(line):
            found.append((1 if "=" in line else 2, "\n".join(para)))
            para = []
            at += 1
            continue
        opened = FENCE_RE.match(line)
        if opened:
            para = []
            at += 1
            while at < len(lines) and not _closes(lines[at], opened.group(1)):
                at += 1
            at += 1
            continue
        heading = HEADING_RE.match(line)
        if heading:
            para = []
            found.append((len(heading.group(1)), heading.group(2) or ""))
            at += 1
            continue
        if RULE_RE.match(line):
            para = []
            at += 1
            continue
        if QUOTE_RE.match(line):
            para = []
            while at < len(lines) and QUOTE_RE.match(lines[at]):
                at += 1
            continue
        if LIST_ITEM_RE.match(line):
            para = []
            at = _list_end(lines, at)
            continue
        if (
            "|" in line
            and at + 1 < len(lines)
            and DELIM_ROW_RE.match(lines[at + 1])
            and "-" in lines[at + 1]
            and len(_split_row(lines[at + 1])) == len(_split_row(line))
        ):
            para = []
            at += 2
            while (
                at < len(lines) and lines[at].strip() and "|" in lines[at]
                and not _starts_block(lines[at])
            ):
                at += 1
            continue
        para.append(re.sub(r"^ {0,3}", "", line))
        at += 1
    return found


def section_headings(md):
    """The text of each ## or ### heading (ATX or Setext), in document order."""
    return [text.strip() for level, text in _top_headings(md) if level in (2, 3)]


def sections(md):
    """How many ## and ### headings the text has outside code, quotes, lists and tables."""
    return len(section_headings(md))


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


# --- result@2 ----------------------------------------------------------------------


class ResultError(ValueError):
    """A result that does not answer its stored payload; pointer is inside data."""

    def __init__(self, pointer, message):
        self.pointer = pointer
        self.message = message
        super().__init__(f"{pointer or '/'}: {message}")


RESULT_FIELDS = ("decision", "note", "refs", "blocks")
REF_FIELDS = ("block", "item", "label")
MAX_NOTE = 4000
MAX_REFS = 20
MAX_REF_LABEL = 120
# the decisions of an ask without an input block; with one, see decisions()
PLAIN_DECISIONS = {
    "read": ("read",),
    "review": ("accept", "revise"),
    "approve": ("approve", "reject", "revise"),
    "do": ("done", "skipped", "revise"),
}
POST_CHOICES = ("posted", "skipped")
# the decision that sends the input block's answer, per (input type, ask)
ANSWERING = {
    ("decide", "approve"): "submit", ("decide", "do"): "submit",
    ("post", "approve"): "approve", ("post", "do"): "submit",
    ("pick", "choose"): "choose",
}
SUMMARY_ORDER = {"approve": ("approve", "reject", "later"), "do": ("done", "skipped", "later")}


def _input(payload):
    """(block id, block) of the input block, or (None, None)."""
    for index, block in enumerate(payload.get("blocks") or []):
        if isinstance(block, dict) and block.get("type") in INPUT_TYPES:
            return block_id(block, index), block
    return None, None


def decisions(payload):
    """The report-level decisions the payload's ask row allows."""
    _, block = _input(payload)
    if block is None:
        return PLAIN_DECISIONS[payload["ask"]]
    answering = ANSWERING[(block["type"], payload["ask"])]
    if answering == "approve":
        return ("approve", "reject", "revise")
    if block["type"] == "pick" and block.get("allow_none") is False:
        # revise is "None of these"; without it a pick must be chosen
        return ("choose",)
    return (answering, "revise")


def _object(value, where, fields, required=()):
    if not isinstance(value, dict):
        raise ResultError(where, "must be an object")
    for key in value:
        if key not in fields:
            raise ResultError(_pointer(where, key), "unknown field")
    for key in required:
        if key not in value:
            raise ResultError(_pointer(where, key), "required field is missing")


def _list(value, where):
    if not isinstance(value, list):
        raise ResultError(where, "must be an array")
    return value


def _one_of(value, where, legal):
    if not isinstance(value, str) or value not in legal:
        raise ResultError(where, "must be one of " + ", ".join(legal))
    return value


def _answers(value, where, wanted, key, check):
    """Every wanted id answered once; the answers in payload order."""
    what = "row" if key == "id" else "platform"
    found = {}
    for index, answer in enumerate(_list(value, where)):
        here = _pointer(where, index)
        check(answer, here)
        name = answer[key]
        if not isinstance(name, str) or name not in wanted:
            raise ResultError(_pointer(here, key), f"is not a {what} of this block")
        if name in found:
            raise ResultError(_pointer(here, key), f"{what} {name!r} answered twice")
        found[name] = (index, answer)
    missing = [name for name in wanted if name not in found]
    if missing:
        raise ResultError(where, f"needs an answer for every {what} (missing: {', '.join(missing)})")
    return [found[name] for name in wanted]


def _decide_answer(block, ask, value, where):
    _object(value, where, ("items",), ("items",))
    at = _pointer(where, "items")
    items = {item["id"]: item for item in block["items"]}

    def check(answer, here):
        _object(answer, here, ("id", "choice"), ("id", "choice"))

    rows = _answers(value["items"], at, list(items), "id", check)
    for index, answer in sorted(rows, key=lambda row: row[0]):
        own = items[answer["id"]].get("choices")
        legal = [choice for choice in CHOICES[ask] if own is None or choice in own]
        _one_of(answer["choice"], _pointer(_pointer(at, index), "choice"), legal)
    return {"items": [{"id": answer["id"], "choice": answer["choice"]} for _, answer in rows]}


def _pick_answer(block, value, where):
    _object(value, where, ("choice",), ("choice",))
    _one_of(value["choice"], _pointer(where, "choice"), [option["id"] for option in block["options"]])
    return {"choice": value["choice"]}


def _post_answer(block, ask, value, where):
    _object(value, where, ("platforms",), ("platforms",))
    at = _pointer(where, "platforms")
    field = "included" if ask == "approve" else "choice"

    def check(answer, here):
        _object(answer, here, ("platform", field), ("platform", field))
        if field == "included" and not isinstance(answer["included"], bool):
            raise ResultError(_pointer(here, "included"), "must be true or false")
        if field == "choice":
            _one_of(answer["choice"], _pointer(here, "choice"), POST_CHOICES)

    names = [entry["platform"] if isinstance(entry, dict) else entry for entry in block["platforms"]]
    rows = _answers(value["platforms"], at, names, "platform", check)
    # limits and media needs are the page's gate (count.js); the server
    # checks the structure of the answer only
    if field == "included" and not any(answer["included"] for _, answer in rows):
        raise ResultError(at, "needs at least one platform included (or decision reject)")
    return {"platforms": [{"platform": answer["platform"], field: answer[field]} for _, answer in rows]}


def _refs(payload, value, where):
    refs = _list(value, where)
    if len(refs) > MAX_REFS:
        raise ResultError(where, f"must hold at most {MAX_REFS} refs")
    targets = anchors(payload)
    seen = set()
    for index, ref in enumerate(refs):
        here = _pointer(where, index)
        _object(ref, here, REF_FIELDS, REF_FIELDS)
        for key in ("block", "item"):
            if not isinstance(ref[key], str):
                raise ResultError(_pointer(here, key), "must be a string")
        label = ref["label"]
        if not isinstance(label, str) or not 1 <= len(label) <= MAX_REF_LABEL:
            raise ResultError(_pointer(here, "label"), f"must be 1-{MAX_REF_LABEL} characters")
        target = (ref["block"], ref["item"])
        if target not in targets:
            raise ResultError(here, "is not a reply target of this report")
        if target in seen:
            raise ResultError(here, "repeats an earlier ref")
        seen.add(target)
    return [{key: ref[key] for key in REF_FIELDS} for ref in refs]


def validate_result(payload, data):
    """The result data, normalized to {decision, note, refs, blocks?}.

    Checked against the stored payload (block ids filled): the decision is
    legal for the ask row; revise has a note; only the decision that answers
    the input block carries `blocks`, and then a complete, legal answer for
    exactly that block; refs point at the payload's reply targets. Raises
    ResultError(pointer inside data, message)."""
    _object(data, "", RESULT_FIELDS, ("decision",))
    decision = _one_of(data["decision"], "/decision", decisions(payload))
    note = data.get("note", "")
    if not isinstance(note, str):
        raise ResultError("/note", "must be a string")
    if len(note) > MAX_NOTE:
        raise ResultError("/note", f"must be at most {MAX_NOTE} characters")
    if decision == "revise" and not note.strip():
        raise ResultError("/note", "revise needs a note (what should change)")
    result = {"decision": decision, "note": note, "refs": _refs(payload, data.get("refs", []), "/refs")}
    name, block = _input(payload)
    if block is None or decision != ANSWERING[(block["type"], payload["ask"])]:
        if "blocks" in data:
            raise ResultError("/blocks", f"decision {decision} carries no blocks")
        return result
    if "blocks" not in data:
        raise ResultError("/blocks", f"required with decision {decision}")
    value = data["blocks"]
    if not isinstance(value, dict) or list(value) != [name]:
        raise ResultError("/blocks", f"must hold exactly the input block {name}")
    where = _pointer("/blocks", name)
    if block["type"] == "decide":
        answer = _decide_answer(block, payload["ask"], value[name], where)
    elif block["type"] == "pick":
        answer = _pick_answer(block, value[name], where)
    else:
        answer = _post_answer(block, payload["ask"], value[name], where)
    result["blocks"] = {name: answer}
    return result


def result_summary(payload, data):
    """One line for `results`: the decision, plus what the input block's
    answer holds ("submit · 2 approve, 1 later", "choose thu",
    "approve · x, linkedin"). None when data does not answer the payload."""
    try:
        data = validate_result(payload, data)
    except (ResultError, KeyError, TypeError):
        return None
    decision = data["decision"]
    if "blocks" not in data:
        return decision
    (answer,) = data["blocks"].values()
    if "choice" in answer:
        return f"{decision} {answer['choice']}"
    if "items" in answer:
        counts = {}
        for row in answer["items"]:
            counts[row["choice"]] = counts.get(row["choice"], 0) + 1
        order = SUMMARY_ORDER[payload["ask"]]
        return f"{decision} · " + ", ".join(f"{counts[c]} {c}" for c in order if counts.get(c))
    if payload["ask"] == "approve":
        return f"{decision} · " + ", ".join(p["platform"] for p in answer["platforms"] if p["included"])
    return f"{decision} · " + ", ".join(f"{p['platform']} {p['choice']}" for p in answer["platforms"])
