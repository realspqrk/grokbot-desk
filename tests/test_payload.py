"""payload@2: the envelope, the blocks and the decision contract of `ask`."""
import copy
import json
import re
from pathlib import Path

import pytest

from core import payload as payload_module
from core.envelope import (
    RUN_ID_RE,
    EnvelopeError,
    validate_payload,
    validate_payload_bytes,
)
from core.payload import ASKS, anchors, input_block, validate_blocks
from core.schema import check_schema


FIXTURES = Path(__file__).resolve().parent / "fixtures" / "payloads"
VALID = sorted(FIXTURES.glob("*.json"))
INVALID = sorted((FIXTURES / "invalid").glob("*.json"))
V1_MESSAGE = (
    "must equal grokbot-desk/payload@2 "
    "(payload@1 and templates were removed; see SKILL.md)"
)


def load(name):
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def report(ask, blocks, **extra):
    payload = {
        "schema": "grokbot-desk/payload@2",
        "bot": "test-bot",
        "title": "A report",
        "created": "2026-10-18T09:00:00+02:00",
        "ask": ask,
        "blocks": blocks,
    }
    payload.update(extra)
    return payload


def fails(payload, pointer, message, **kwargs):
    with pytest.raises(EnvelopeError) as caught:
        validate_payload(payload, **kwargs)
    assert caught.value.pointer == pointer, caught.value
    assert message in caught.value.message, caught.value
    return caught.value


TEXT = {"type": "text", "md": "Hello."}
DECIDE = {"type": "decide", "items": [{"id": "a", "title": "Item A"}, {"id": "b", "title": "Item B"}]}
PICK = {"type": "pick", "options": [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}]}
POST = {"type": "post", "author": {"name": "Shop", "handle": "shop"}, "text": "Hello.", "hashtags": []}
POST_AUTO = dict(POST, platforms=["x", "linkedin"])
POST_MANUAL = dict(POST, platforms=[{"platform": "x", "mode": "manual"}])


def test_the_expected_fixtures_exist():
    names = {path.stem for path in VALID}
    assert names == {
        "read", "review", "approve", "approve-decide", "approve-post",
        "do", "do-decide", "do-post", "choose", "report-long",
    }
    assert len(INVALID) >= 15
    for path in INVALID:
        assert path.with_suffix(".expect").is_file(), path.name


def test_every_block_type_appears_in_a_valid_fixture():
    seen = {block["type"] for path in VALID for block in json.loads(path.read_text(encoding="utf-8"))["blocks"]}
    assert seen == set(payload_module.BLOCK_TYPES)


@pytest.mark.parametrize("path", VALID, ids=lambda path: path.stem)
def test_every_valid_fixture_validates(path):
    raw = path.read_bytes()
    warnings = []
    result = validate_payload_bytes(raw, warnings=warnings)
    assert warnings == []
    assert RUN_ID_RE.fullmatch(result["run_id"])
    assert all(re.fullmatch(r"[a-z0-9-]{1,40}", block["id"]) for block in result["blocks"])
    # the input is left as it was
    assert json.loads(raw) == load(path.stem)


@pytest.mark.parametrize("path", INVALID, ids=lambda path: path.stem)
def test_every_invalid_fixture_fails_at_expected_pointer(path):
    expect = json.loads(path.with_suffix(".expect").read_text(encoding="utf-8"))
    with pytest.raises(EnvelopeError) as caught:
        validate_payload_bytes(path.read_bytes())
    assert caught.value.pointer == expect["pointer"], caught.value
    assert expect["message"] in caught.value.message, caught.value


def test_payload_v1_rejected_with_pointer_to_skill():
    old = {
        "schema": "report-shell/payload@1",
        "template": "approve-one",
        "version": 1,
        "bot": "test-bot",
        "title": "Old",
        "created": "2026-10-18T09:00:00+02:00",
        "data": {},
    }
    error = fails(old, "/schema", V1_MESSAGE)
    assert error.message == V1_MESSAGE
    fails(dict(load("read"), schema="grokbot-desk/payload@1"), "/schema", V1_MESSAGE)
    missing = load("read")
    del missing["schema"]
    fails(missing, "/schema", "required field is missing")


@pytest.mark.parametrize("field", ["template", "version", "task", "notify", "data"])
def test_fields_dropped_from_payload_v1_are_unknown(field):
    fails(dict(load("read"), **{field: 1}), f"/{field}", "unknown field")


def test_block_ids_autofilled_and_unique():
    result = validate_payload(report("read", [TEXT, dict(TEXT, id="notes"), TEXT]))
    assert [block["id"] for block in result["blocks"]] == ["b1", "notes", "b3"]
    # an explicit id may look like a generated one, as long as nothing repeats
    result = validate_payload(report("read", [dict(TEXT, id="b2"), dict(TEXT, id="b1")]))
    assert [block["id"] for block in result["blocks"]] == ["b2", "b1"]
    fails(report("read", [dict(TEXT, id="x"), dict(TEXT, id="x")]), "/blocks/1/id", "duplicate block id")
    fails(report("read", [dict(TEXT, id="b2"), TEXT]), "/blocks/1", "duplicate block id 'b2'")
    fails(report("read", [dict(TEXT, id="Notes")]), "/blocks/0/id", "must match pattern")
    fails(report("read", [dict(TEXT, id="x" * 41)]), "/blocks/0/id", "must match pattern")
    # the caller's payload keeps its shape
    source = report("approve", [TEXT, DECIDE])
    before = copy.deepcopy(source)
    validated = validate_payload(source)
    assert source == before
    assert input_block(validated)["id"] == "b2"


def test_one_input_block_max():
    fails(report("approve", [DECIDE, POST_AUTO]), "/blocks/1", "only one input block")
    fails(report("approve", [TEXT, DECIDE, dict(DECIDE, id="more")]), "/blocks/2", "only one input block")
    fails(report("choose", [PICK, dict(PICK, id="second")]), "/blocks/1", "only one input block")


CONTRACT = [
    ("read", None, {}),
    ("review", None, {}),
    ("approve", None, {"action": "deploy"}),
    ("approve", DECIDE, {}),
    ("approve", POST_AUTO, {}),
    ("do", None, {}),
    ("do", DECIDE, {}),
    ("do", POST_MANUAL, {}),
    ("do", POST_AUTO, {}),  # plain ids follow the ask: manual under do
    ("do", dict(POST, platforms=[{"platform": "x"}]), {}),  # no mode: follows the ask
    ("approve", dict(POST, platforms=[{"platform": "x"}, {"platform": "linkedin", "mode": "auto"}]), {}),
    ("choose", PICK, {}),
]

FORBIDDEN = [
    ("read", DECIDE, {}, "/blocks/1/type", "ask read takes no input block"),
    ("read", PICK, {}, "/blocks/1/type", "ask read takes no input block"),
    ("read", POST_AUTO, {}, "/blocks/1/type", "ask read takes no input block"),
    ("review", DECIDE, {}, "/blocks/1/type", "ask review takes no input block"),
    ("review", PICK, {}, "/blocks/1/type", "ask review takes no input block"),
    ("review", POST_MANUAL, {}, "/blocks/1/type", "ask review takes no input block"),
    ("approve", None, {}, "/action", "needs action"),
    ("approve", PICK, {}, "/blocks/1/type", "ask approve takes no pick block"),
    ("approve", POST_MANUAL, {}, "/blocks/1/platforms/0/mode", "ask approve needs every platform auto"),
    ("approve", dict(POST, platforms=["x", {"platform": "linkedin", "mode": "manual"}]), {},
     "/blocks/1/platforms/1", "must be one of"),
    ("approve", dict(DECIDE, items=[{"id": "a", "title": "A", "choices": ["done"]}]), {},
     "/blocks/1/items/0/choices/0", "ask approve"),
    ("do", PICK, {}, "/blocks/1/type", "ask do takes no pick block"),
    ("do", dict(POST, platforms=[{"platform": "x", "mode": "auto"}]), {},
     "/blocks/1/platforms/0/mode", "ask do needs every platform manual"),
    ("do", dict(POST, platforms=[{"platform": "x", "mode": "manual"}, {"platform": "facebook", "mode": "auto"}]), {},
     "/blocks/1/platforms/1/mode", "ask do needs every platform manual"),
    ("do", dict(DECIDE, labels={"approve": "Pay"}), {}, "/blocks/1/labels", "ask do"),
    ("do", dict(DECIDE, items=[{"id": "a", "title": "A", "labels": {"later": "Soon"}}]), {},
     "/blocks/1/items/0/labels", "ask do"),
    ("do", dict(DECIDE, items=[{"id": "a", "title": "A", "choices": ["done", "reject"]}]), {},
     "/blocks/1/items/0/choices/1", "ask do"),
    ("choose", None, {}, "/blocks", "ask choose needs a pick block"),
    ("choose", DECIDE, {}, "/blocks/1/type", "ask choose takes no decide block"),
    ("choose", POST_AUTO, {}, "/blocks/1/type", "ask choose takes no post block"),
]


def _blocks(block):
    return [copy.deepcopy(TEXT)] + ([copy.deepcopy(block)] if block else [])


@pytest.mark.parametrize(("ask", "block", "extra"), CONTRACT)
def test_ask_block_matrix(ask, block, extra):
    result = validate_payload(report(ask, _blocks(block), **extra))
    found = input_block(result)
    assert (found or {}).get("type") == (block or {}).get("type")
    assert ask in ASKS


@pytest.mark.parametrize(("ask", "block", "extra", "pointer", "message"), FORBIDDEN)
def test_ask_block_matrix_rejects_what_the_contract_forbids(ask, block, extra, pointer, message):
    fails(report(ask, _blocks(block), **extra), pointer, message)


def test_asks_are_the_five_of_the_contract():
    assert ASKS == ("read", "review", "approve", "do", "choose")
    fails(report("fyi", [TEXT]), "/ask", "must be one of read, review, approve, do, choose")
    missing = report("read", [TEXT])
    del missing["ask"]
    fails(missing, "/ask", "required field is missing")


def test_validate_blocks_alone_checks_the_contract():
    validate_blocks(report("approve", [TEXT, DECIDE]))
    with pytest.raises(EnvelopeError) as caught:
        validate_blocks(report("read", [TEXT, DECIDE]))
    assert caught.value.pointer == "/blocks/1/type"


def decide_with(labels=None, item_labels=None, choices=None):
    item = {"id": "a", "title": "Item A"}
    if item_labels is not None:
        item["labels"] = item_labels
    if choices is not None:
        item["choices"] = choices
    block = {"type": "decide", "items": [item]}
    if labels is not None:
        block["labels"] = labels
    return report("approve", [block])


@pytest.mark.parametrize(
    ("labels", "item_labels", "choices", "pointer", "message"),
    [
        ({"approve": "Reject"}, None, None, "/blocks/0/labels/approve", "reads like the reject choice"),
        ({"approve": "REJECT"}, None, None, "/blocks/0/labels/approve", "reads like the reject choice"),
        ({"approve": "Ablehnen"}, None, None, "/blocks/0/labels/approve", "reads like the reject choice"),
        ({"reject": "Freigeben"}, None, None, "/blocks/0/labels/reject", "reads like the approve choice"),
        ({"reject": "Approve"}, None, None, "/blocks/0/labels/reject", "reads like the approve choice"),
        ({"approve": "Defer"}, None, None, "/blocks/0/labels/approve", "reads like the later choice"),
        ({"approve": "Zurückstellen"}, None, None, "/blocks/0/labels/approve", "reads like the later choice"),
        ({"later": "Approve"}, None, None, "/blocks/0/labels/later", "reads like the approve choice"),
        (None, {"approve": "Ablehnen"}, None, "/blocks/0/items/0/labels/approve", "reads like the reject choice"),
        ({"approve": "Go", "reject": "go"}, None, None, "/blocks/0/labels/reject", "repeats the approve choice"),
        ({"approve": "Go"}, {"reject": "Go"}, None, "/blocks/0/items/0/labels/reject", "repeats the approve choice"),
        # a label the item never shows still may not read like another choice
        ({"later": "Ablehnen"}, None, ["approve", "reject"], "/blocks/0/labels/later", "reads like the reject choice"),
    ],
)
def test_label_clash_both_languages(labels, item_labels, choices, pointer, message):
    fails(decide_with(labels, item_labels, choices), pointer, message)


@pytest.mark.parametrize(
    ("labels", "item_labels", "choices"),
    [
        ({"approve": "Pay", "reject": "Don't pay", "later": "Next week"}, None, None),
        ({"approve": "Pay"}, {"approve": "Bezahlen"}, None),
        ({"later": "Defer"}, None, None),  # its own default in another word
        ({"approve": "Pay", "later": "Pay later"}, {"approve": "Pay now"}, None),
        (None, None, ["approve", "later"]),
    ],
)
def test_label_combinations_that_read_right_are_kept(labels, item_labels, choices):
    validate_payload(decide_with(labels, item_labels, choices))


def test_old_defer_label_key_is_gone():
    fails(decide_with({"defer": "Later"}), "/blocks/0/labels/defer", "unknown property")


def test_decide_item_due_is_a_real_calendar_day():
    block = {"type": "decide", "items": [{"id": "a", "title": "A", "due": "2026-02-29"}]}
    fails(report("approve", [block]), "/blocks/0/items/0/due", "real calendar date")
    block["items"][0]["due"] = "2028-02-29"
    validate_payload(report("approve", [block]))
    block["items"][0]["due"] = "2026-13-01"
    fails(report("approve", [block]), "/blocks/0/items/0/due", "must match pattern")


@pytest.mark.parametrize(
    ("md", "sections"),
    [
        ("## One\n\n## Two\n\n### Three", 3),
        ("# Title\n\n#### Deep\n\n##### Deeper", 0),
        ("```\n## code\n```\n## Real", 1),
        ("~~~\n## code\n~~~\n## Real", 1),
        ("````\n## code\n```\n## still code\n````\n## Real", 1),
        ("```\n## never closed\n## also code", 0),
        ("   ## three spaces\n    ## four spaces is code", 1),
        ("##no space\n## Heading ##", 1),
        ("Text\n\n## A\ntext\n### B\n```js\nconst x = 1;\n```\n### C", 3),
        # Setext: a line of - under paragraph text is an h2; after a blank line it is a rule
        ("Title\n---\n\nText", 1),
        ("Title\n=====\n\nText", 0),
        ("Text\n\n---\n\nMore", 0),
        ("- item\n---", 0),
        ("> quoted\n---", 0),
        ("```\nTitle\n---\n```", 0),
        ("a|b\n---", 1),  # not a table (one delimiter cell for two head cells): a heading
        ("a|b\n-|-\n---", 0),  # a table, then a rule
    ],
)
def test_anchors_sections_ignore_fences(md, sections):
    validated = validate_payload(report("review", [{"type": "text", "id": "doc", "md": md}]))
    assert anchors(validated) == {("doc", f"section:{n}") for n in range(sections)}


def test_sections_mix_setext_and_atx_in_document_order():
    md = (
        "Intro\n\nFirst\n---\n\nbody\n\n## Second\n\nPara line one\nline two\n  ---\n\n"
        "### Fourth\n\n```\nCode\n---\n```\n\nTop\n===\n\n---\n\nFifth  \n-\n"
    )
    assert payload_module.section_headings(md) == ["First", "Second", "Para line one\nline two", "Fourth", "Fifth"]
    validated = validate_payload(report("review", [{"type": "text", "id": "doc", "md": md}]))
    assert anchors(validated) == {("doc", f"section:{n}") for n in range(5)}


def test_anchors_name_every_addressable_target():
    assert anchors(validate_payload(load("report-long"))) == {
        ("details", "section:0"), ("details", "section:1"), ("details", "section:2"),
    }
    assert anchors(validate_payload(load("approve-decide"))) == {
        ("invoices", "hosting"), ("invoices", "toner"), ("invoices", "parking"),
    }
    assert anchors(validate_payload(load("choose"))) == {("date", "thu"), ("date", "fri")}
    assert anchors(validate_payload(load("approve-post"))) == {("post", "x"), ("post", "linkedin")}
    assert anchors(validate_payload(load("do-post"))) == {("b1", "instagram"), ("b1", "facebook")}
    assert anchors(validate_payload(load("review"))) == {
        ("guide", "section:0"), ("guide", "section:1"), ("guide", "section:2"),
    }
    assert anchors(validate_payload(load("approve"))) == set()


def test_created_clamp_and_dedupe_fields_unchanged():
    warnings = []
    ahead = validate_payload(report("read", [TEXT], created="2099-01-01T00:00:00+00:00"), warnings=warnings)
    assert ahead["created"] != "2099-01-01T00:00:00+00:00"
    assert warnings and "clamped" in warnings[0] and warnings[0].startswith("/created")
    plain = validate_payload(report("read", [TEXT]))
    assert plain["created"] == "2026-10-18T09:00:00+02:00"
    assert plain["expires_minutes"] == 240
    assert RUN_ID_RE.fullmatch(plain["run_id"])
    assert plain["run_id"].split("-")[2:4] == ["test", "bot"]
    kept = validate_payload(report("read", [TEXT], run_id="20261019-090000-test-abcd"))
    assert kept["run_id"] == "20261019-090000-test-abcd"
    fails(report("read", [TEXT], run_id="20261019-090000-test-abcd"), "/run_id", "already used",
          used_ids={"20261019-090000-test-abcd"})
    fails(report("read", [TEXT], run_id="nope"), "/run_id", "invalid run id")
    deduped = validate_payload(report("read", [TEXT], dedupe_key="weekly-review", dedupe_hours=72))
    assert (deduped["dedupe_key"], deduped["dedupe_hours"]) == ("weekly-review", 72)
    fails(report("read", [TEXT], dedupe_key=""), "/dedupe_key", "printable ASCII")
    fails(report("read", [TEXT], dedupe_key=" leading"), "/dedupe_key", "printable ASCII")
    fails(report("read", [TEXT], dedupe_key="k" * 121), "/dedupe_key", "printable ASCII")
    fails(report("read", [TEXT], dedupe_hours=24), "/dedupe_hours", "needs dedupe_key")
    fails(report("read", [TEXT], dedupe_key="k", dedupe_hours=169), "/dedupe_hours", "1 to 168")
    fails(report("read", [TEXT], dedupe_key="k", dedupe_hours=True), "/dedupe_hours", "1 to 168")
    fails(report("read", [TEXT], expires_minutes=4), "/expires_minutes", "5 to 10080")
    fails(report("read", [TEXT], expires_minutes=10081), "/expires_minutes", "5 to 10080")
    fails(report("read", [TEXT], created="2026-10-19T09:00:00"), "/created", "ISO 8601")
    fails(report("read", [TEXT], bot="Test Bot"), "/bot", "invalid bot slug")
    fails(report("read", [TEXT], title=""), "/title", "1-80")
    fails(report("read", [TEXT], title="x" * 81), "/title", "1-80")


def test_payload_bytes_boundaries():
    with pytest.raises(EnvelopeError) as caught:
        validate_payload_bytes(b"{" + b" " * (2 * 1024 * 1024) + b"}")
    assert "2 MB" in caught.value.message
    with pytest.raises(EnvelopeError) as caught:
        validate_payload_bytes(b'{"schema": ')
    assert "invalid JSON" in caught.value.message
    with pytest.raises(EnvelopeError) as caught:
        validate_payload_bytes(b"[]")
    assert caught.value.message == "payload must be an object"


def test_why_warns_not_fails():
    warnings = []
    long = "One. Two. Three. Four is folded."
    assert validate_payload(report("read", [TEXT], why=long), warnings=warnings)["why"] == long
    assert any(note.startswith("/why:") and "sentence" in note for note in warnings)
    warnings.clear()
    validate_payload(report("read", [TEXT], why="Word " * 90), warnings=warnings)
    assert any(note.startswith("/why:") and "360" in note for note in warnings)
    warnings.clear()
    validate_payload(report("read", [TEXT], why="Short."), warnings=warnings)
    assert warnings == []
    fails(report("read", [TEXT], why="  "), "/why", "non-empty string")
    fails(report("read", [TEXT], why=3), "/why", "non-empty string")


def test_due_urgent_action_and_label():
    for due in ("2026-10-23", "2026-10-23T15:00Z", "2026-10-23T15:00:00+02:00", "2026-10-23T15:00:00.250Z"):
        assert validate_payload(report("read", [TEXT], due=due))["due"] == due
    for due in ("2026-02-30", "2026-10-23 15:00", "20261023", "2026-W43", "2026-10-23T15:00", 20261023):
        fails(report("read", [TEXT], due=due), "/due", "YYYY-MM-DD")
    assert validate_payload(report("read", [TEXT], urgent=True))["urgent"] is True
    fails(report("read", [TEXT], urgent="yes"), "/urgent", "boolean")
    fails(report("approve", [TEXT], action=""), "/action", "1-24")
    fails(report("approve", [TEXT], action="x" * 25), "/action", "1-24")
    fails(report("approve", [TEXT], action="pay\nnow"), "/action", "1-24")
    fails(report("approve", [TEXT], action="deploy", label="y" * 25), "/label", "1-24")
    fails(report("approve", [TEXT], action="deploy", label=" padded"), "/label", "1-24")


def _row(ask, block):
    return report(ask, [block])


TABLE = {"type": "table", "columns": [{"key": "name", "label": "Name"}, {"key": "n", "label": "N", "type": "number"}],
         "rows": [{"name": "a", "n": 1}]}
CHART = {"type": "chart", "kind": "bar", "labels": ["a", "b"], "series": [{"name": "s", "values": [1, 2]}]}


@pytest.mark.parametrize(
    ("payload", "pointer", "message"),
    [
        (report("read", []), "/blocks", "at least 1"),
        (report("read", [TEXT] * 41), "/blocks", "at most 40"),
        (report("read", [TEXT, "text"]), "/blocks/1", "must be an object"),
        (report("read", [{"md": "x"}]), "/blocks/0/type", "required"),
        (report("read", [dict(TEXT, extra=1)]), "/blocks/0/extra", "unknown property"),
        (report("read", [dict(TEXT, md="")]), "/blocks/0/md", "at least 1"),
        (report("read", [dict(TEXT, title="t" * 81)]), "/blocks/0/title", "at most 80"),
        (report("read", [{"type": "stats", "items": [{"label": "a", "value": "1"}] * 5}]), "/blocks/0/items", "at most 4"),
        (report("read", [{"type": "stats", "items": [{"label": "a", "value": "1", "good": "left"}]}]),
         "/blocks/0/items/0/good", "must be one of"),
        (report("read", [{"type": "stats", "items": [{"label": "a", "value": "1", "spark": [1, "2"]}]}]),
         "/blocks/0/items/0/spark/1", "expected number"),
        (report("read", [{"type": "stats", "items": [{"label": "a", "value": "1", "spark": [1, float("inf")]}]}]),
         "/blocks/0/items/0/spark/1", "finite"),
        (report("read", [{"type": "facts", "items": [{"label": "a", "value": "1"}] * 9}]), "/blocks/0/items", "at most 8"),
        (report("read", [{"type": "checks", "items": [{"label": "a", "state": "done"}]}]),
         "/blocks/0/items/0/state", "must be one of"),
        (report("read", [dict(TABLE, columns=[{"key": f"c{n}", "label": "C"} for n in range(13)])]),
         "/blocks/0/columns", "at most 12"),
        (report("read", [dict(TABLE, rows=[{"name": "a"}] * 201)]), "/blocks/0/rows", "at most 200"),
        (report("read", [dict(TABLE, columns=[{"key": "a", "label": "A"}, {"key": "a", "label": "B"}])]),
         "/blocks/0/columns/1/key", "duplicate key"),
        (report("read", [dict(TABLE, columns=[{"key": "a", "label": "A", "type": "currency"}])]),
         "/blocks/0/columns/0/type", "must be one of"),
        (report("read", [dict(TABLE, rows=[{"name": "a", "n": "1"}])]), "/blocks/0/rows/0/n", "number column"),
        (report("read", [dict(TABLE, rows=[{"name": ["a"], "n": 1}])]), "/blocks/0/rows/0/name", "text column"),
        (report("read", [dict(TABLE, total={"name": "Total", "n": "many"})]), "/blocks/0/total/n", "number column"),
        (report("read", [dict(TABLE, total={"sum": 1})]), "/blocks/0/total/sum", "not a column"),
        (report("read", [dict(TABLE, columns=[{"key": "s", "label": "S", "type": "status"}], rows=[{"s": "great"}])]),
         "/blocks/0/rows/0/s", "status column"),
        (report("read", [dict(TABLE, columns=[{"key": "d", "label": "D", "type": "date"}], rows=[{"d": "2026-02-30"}])]),
         "/blocks/0/rows/0/d", "date column"),
        (report("read", [dict(TABLE, rows=[{"name": "x" * 501}])]), "/blocks/0/rows/0/name", "at most 500"),
        (report("read", [dict(CHART, kind="pie")]), "/blocks/0/kind", "must be one of"),
        (report("read", [dict(CHART, kind="line", orientation="horizontal")]), "/blocks/0/orientation", "bar chart"),
        (report("read", [dict(CHART, labels=[str(n) for n in range(61)],
                              series=[{"name": "s", "values": list(range(61))}])]), "/blocks/0/labels", "at most 60"),
        (report("read", [dict(CHART, series=[{"name": "s", "values": [1, None]}])]),
         "/blocks/0/series/0/values/1", "expected number"),
        (report("read", [dict(CHART, target=float("nan"))]), "/blocks/0/target", "finite"),
        (report("read", [{"type": "media", "path": "/srv/media/a.png"}]), "/blocks/0/alt", "required"),
        (report("read", [{"type": "media", "path": "/srv/media/a.png", "alt": "A", "poster": "/srv/media/b.png"}]),
         "/blocks/0/poster", "video"),
        (report("read", [{"type": "copy", "items": []}]), "/blocks/0/items", "at least 1"),
        (report("read", [dict(TEXT, images=[{"key": "a", "path": "/m/a.png", "alt": "A"}] * 2)]),
         "/blocks/0/images/1/key", "duplicate key"),
        (_row("approve", dict(DECIDE, items=[])), "/blocks/0/items", "at least 1"),
        (_row("approve", dict(DECIDE, items=[{"id": f"i{n}", "title": "t"} for n in range(13)])), "/blocks/0/items", "at most 12"),
        (_row("approve", dict(DECIDE, items=[{"id": "a", "title": "A"}, {"id": "a", "title": "B"}])),
         "/blocks/0/items/1/id", "duplicate id"),
        (_row("approve", dict(DECIDE, items=[{"id": "a", "title": "A", "actor": "user"}])),
         "/blocks/0/items/0/actor", "unknown property"),
        (_row("approve", dict(DECIDE, items=[{"id": "a", "title": "A", "choices": ["approve", "approve"]}])),
         "/blocks/0/items/0/choices", "unique"),
        (_row("approve", dict(DECIDE, items=[{"id": "a", "title": "A", "url": "ftp://example.com/x"}])),
         "/blocks/0/items/0/url", "must match pattern"),
        (_row("choose", dict(PICK, options=PICK["options"][:1])), "/blocks/0/options", "at least 2"),
        (_row("choose", dict(PICK, suggested="c")), "/blocks/0/suggested", "option id"),
        (_row("choose", dict(PICK, allow_none="yes")), "/blocks/0/allow_none", "expected boolean"),
        (_row("approve", dict(POST_AUTO, image={"path": "/m/a.png", "alt": "A", "ratio": "1:1"},
                              video={"path": "/m/a.mp4", "poster": "/m/a.png", "alt": "A", "ratio": "1:1"})),
         "/blocks/0/video", "cannot be combined with image"),
        (_row("approve", dict(POST_AUTO, platforms=["x", "x"])), "/blocks/0/platforms/1", "duplicate platform 'x'"),
        (_row("do", dict(POST_AUTO, platforms=[{"platform": "x", "mode": "manual"}, {"platform": "x", "mode": "manual"}])),
         "/blocks/0/platforms/1", "duplicate platform 'x'"),
        (_row("approve", dict(POST_AUTO, platforms=["mastodon"])), "/blocks/0/platforms/0", "must be one of"),
    ],
)
def test_block_rules(payload, pointer, message):
    fails(payload, pointer, message)


HUGE = "1" + "0" * 400


def _huge_raw(blocks_json, ask="read"):
    return (
        '{"schema": "grokbot-desk/payload@2", "bot": "test-bot", "title": "Big", '
        '"created": "2026-10-18T09:00:00+02:00", "ask": "%s", "blocks": [%s]}' % (ask, blocks_json)
    ).encode()


@pytest.mark.parametrize(
    ("blocks_json", "pointer"),
    [
        ('{"type": "table", "columns": [{"key": "n", "label": "N", "type": "number"}], "rows": [{"n": %s}]}',
         "/blocks/0/rows/0/n"),
        ('{"type": "table", "columns": [{"key": "t", "label": "T"}], "rows": [{"t": %s}]}',
         "/blocks/0/rows/0/t"),
        ('{"type": "table", "columns": [{"key": "n", "label": "N", "type": "money"}], "rows": [{"n": 1}], "total": {"n": %s}}',
         "/blocks/0/total/n"),
        ('{"type": "chart", "kind": "bar", "labels": ["a"], "series": [{"name": "s", "values": [%s]}]}',
         "/blocks/0/series/0/values/0"),
        ('{"type": "chart", "kind": "line", "labels": ["a"], "series": [{"name": "s", "values": [1]}], "target": -%s}',
         "/blocks/0/target"),
        ('{"type": "stats", "items": [{"label": "a", "value": "1", "spark": [1, %s]}]}',
         "/blocks/0/items/0/spark/1"),
        ('{"type": "stats", "items": [{"label": "a", "value": "1", "delta": %s}]}',
         "/blocks/0/items/0/delta"),
    ],
)
def test_a_number_too_large_for_a_float_is_an_envelope_error(blocks_json, pointer):
    with pytest.raises(EnvelopeError) as caught:
        validate_payload_bytes(_huge_raw(blocks_json % HUGE))
    assert caught.value.pointer == pointer, caught.value
    assert "finite" in caught.value.message


def test_blocks_schema_is_restricted_json_schema_with_media_markers():
    schemas = payload_module.BLOCK_SCHEMAS
    assert set(schemas) == set(payload_module.BLOCK_TYPES)
    for name, schema in schemas.items():
        check_schema(schema, f"/{name}")
        assert schema["additionalProperties"] is False, name
    assert schemas["media"]["properties"]["path"]["x-rs-media"] == "any"
    assert schemas["text"]["properties"]["images"]["items"]["properties"]["path"]["x-rs-media"] is True
    post = schemas["post"]["properties"]
    assert post["image"]["properties"]["path"]["x-rs-media"] is True
    assert post["video"]["properties"]["path"]["x-rs-media"] == "video"
    assert post["video"]["properties"]["poster"]["x-rs-media"] is True
    assert post["author"]["properties"]["avatar"]["x-rs-media"] is True


def test_a_media_block_registers_an_image_or_a_video(tmp_path):
    from core.media import MediaError, replace_media

    image = tmp_path / "shot.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 16)
    video = tmp_path / "clip.webm"
    video.write_bytes(b"\x1aE\xdf\xa3" + b"0" * 16)
    schema = payload_module.BLOCK_SCHEMAS["media"]
    for path in (image, video):
        media = {}
        block = {"type": "media", "path": str(path), "alt": "A"}
        replaced = replace_media(block, schema, [str(tmp_path)], media)
        assert replaced["path"] in media
    text = tmp_path / "notes.txt"
    text.write_text("x", encoding="utf-8")
    with pytest.raises(MediaError):
        replace_media({"type": "media", "path": str(text), "alt": "A"}, schema, [str(tmp_path)], {})
