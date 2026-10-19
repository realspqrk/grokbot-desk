"""result@2: the person's answer, checked against the stored payload."""
import json
from pathlib import Path

import pytest

from core.envelope import validate_payload
from core.payload import ResultError, result_summary, validate_result


FIXTURES = Path(__file__).resolve().parent / "fixtures" / "payloads"


def stored(name, **changes):
    """A fixture as the store keeps it: validated, block ids filled.
    choose-none is the choose fixture with "None of these" allowed."""
    allow_none = name == "choose-none"
    name = "choose" if allow_none else name
    payload = json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))
    if allow_none:
        del payload["blocks"][1]["allow_none"]
    for key, value in changes.items():
        if value is None:
            payload.pop(key, None)
        else:
            payload[key] = value
    return validate_payload(payload)


def report(ask, blocks, **extra):
    return validate_payload({
        "schema": "grokbot-desk/payload@2", "bot": "test-bot", "title": "A report",
        "created": "2026-10-18T09:00:00+02:00", "ask": ask, "blocks": blocks, **extra,
    })


def fails(payload, data, pointer, message):
    with pytest.raises(ResultError) as caught:
        validate_result(payload, data)
    assert caught.value.pointer == pointer, caught.value
    assert message in caught.value.message, caught.value
    return caught.value


def rows(*choices, ids=("hosting", "toner", "parking"), block="invoices"):
    return {block: {"items": [{"id": i, "choice": c} for i, c in zip(ids, choices)]}}


POST = {"type": "post", "id": "post", "author": {"name": "Shop", "handle": "shop"}, "text": "Hello.", "hashtags": []}


# --- the decision contract ----------------------------------------------------


def test_submit_with_rejected_rows_is_not_approval():
    payload = stored("approve-decide")
    data = validate_result(payload, {"decision": "submit", "blocks": rows("approve", "reject", "reject")})
    assert data == {
        "decision": "submit", "note": "", "refs": [],
        "blocks": rows("approve", "reject", "reject"),
    }
    assert result_summary(payload, data) == "submit · 1 approve, 2 reject"
    # with a decide block the report decision is never an approval word
    fails(payload, {"decision": "approve", "blocks": rows("approve", "approve", "approve")},
          "/decision", "must be one of submit, revise")


@pytest.mark.parametrize("name, legal", [
    ("read", ["read"]),
    ("review", ["accept", "revise"]),
    ("approve", ["approve", "reject", "revise"]),
    ("approve-decide", ["submit", "revise"]),
    ("approve-post", ["approve", "reject", "revise"]),
    ("do", ["done", "skipped", "revise"]),
    ("do-decide", ["submit", "revise"]),
    ("do-post", ["submit", "revise"]),
    ("choose", ["choose"]),
    ("choose-none", ["choose", "revise"]),
])
def test_each_ask_row_allows_its_decisions_only(name, legal):
    payload = stored(name)
    fails(payload, {"decision": "later"}, "/decision", "must be one of " + ", ".join(legal))


def test_result_rejects_unknown_or_missing_row():
    payload = stored("approve-decide")
    fails(payload, {"decision": "submit", "blocks": rows("approve", "reject")},
          "/blocks/invoices/items", "needs an answer for every row (missing: parking)")
    fails(payload, {"decision": "submit", "blocks": rows("approve", "reject", "approve", ids=("hosting", "toner", "ghost"))},
          "/blocks/invoices/items/2/id", "is not a row of this block")
    fails(payload, {"decision": "submit", "blocks": rows("approve", "approve", "reject", ids=("hosting", "hosting", "parking"))},
          "/blocks/invoices/items/1/id", "answered twice")
    fails(payload, {"decision": "submit", "blocks": rows("approve", "reject", "later")},
          "/blocks/invoices/items/2/choice", "must be one of approve, reject")
    fails(payload, {"decision": "submit", "blocks": rows("done", "reject", "reject")},
          "/blocks/invoices/items/0/choice", "must be one of approve, reject, later")
    fails(payload, {"decision": "submit", "blocks": rows("approve", "reject", "reject", block="other")},
          "/blocks", "must hold exactly the input block invoices")
    fails(payload, {"decision": "submit"}, "/blocks", "required with decision submit")


def test_rows_come_back_in_payload_order():
    payload = stored("approve-decide")
    answer = {"invoices": {"items": [
        {"id": "parking", "choice": "approve"}, {"id": "hosting", "choice": "later"},
        {"id": "toner", "choice": "reject"},
    ]}}
    data = validate_result(payload, {"decision": "submit", "blocks": answer})
    assert [row["id"] for row in data["blocks"]["invoices"]["items"]] == ["hosting", "toner", "parking"]


def test_do_rows_take_the_persons_choices():
    payload = stored("do-decide")
    answer = rows("done", "skipped", "later", ids=("reply-1", "reply-2", "reply-3"), block="replies")
    data = validate_result(payload, {"decision": "submit", "blocks": answer})
    assert result_summary(payload, data) == "submit · 1 done, 1 skipped, 1 later"
    fails(payload, {"decision": "submit", "blocks": rows("approve", "done", "done", ids=("reply-1", "reply-2", "reply-3"), block="replies")},
          "/blocks/replies/items/0/choice", "must be one of done, skipped, later")


def test_revise_needs_note():
    payload = stored("review")
    fails(payload, {"decision": "revise"}, "/note", "revise needs a note")
    fails(payload, {"decision": "revise", "note": "  \n "}, "/note", "revise needs a note")
    data = validate_result(payload, {"decision": "revise", "note": "Shorter, please."})
    assert data == {"decision": "revise", "note": "Shorter, please.", "refs": []}
    fails(payload, {"decision": "accept", "note": "x" * 4001}, "/note", "at most 4000")
    fails(payload, {"decision": "accept", "note": 3}, "/note", "must be a string")


@pytest.mark.parametrize("name, decision", [
    ("approve-decide", "revise"),
    ("approve-post", "reject"),
    ("approve-post", "revise"),
    ("choose-none", "revise"),
    ("read", "read"),
    ("approve", "approve"),
    ("do", "done"),
])
def test_reject_carries_no_blocks(name, decision):
    payload = stored(name)
    data = {"decision": decision, "note": "Not now.", "blocks": {}}
    fails(payload, data, "/blocks", f"decision {decision} carries no blocks")
    del data["blocks"]
    assert "blocks" not in validate_result(payload, data)


def test_result_rejects_unknown_fields_and_shapes():
    payload = stored("read")
    fails(payload, {"decision": "read", "comment": "x"}, "/comment", "unknown field")
    fails(payload, ["read"], "", "must be an object")
    fails(payload, {}, "/decision", "required")


# --- reply refs ------------------------------------------------------------------


def test_refs_must_be_anchors():
    payload = stored("review")
    ok = validate_result(payload, {"decision": "revise", "note": "Fix these.", "refs": [
        {"block": "guide", "item": "section:0", "label": "First day"},
        {"block": "guide", "item": "section:2", "label": "Accounts"},
    ]})
    assert len(ok["refs"]) == 2
    fails(payload, {"decision": "revise", "note": "x", "refs": [{"block": "guide", "item": "section:3", "label": "x"}]},
          "/refs/0", "is not a reply target of this report")
    fails(payload, {"decision": "revise", "note": "x", "refs": [{"block": "b2", "item": "section:0", "label": "x"}]},
          "/refs/0", "is not a reply target of this report")
    decide = stored("approve-decide")
    validate_result(decide, {"decision": "revise", "note": "x", "refs": [{"block": "invoices", "item": "toner", "label": "Toner"}]})
    fails(decide, {"decision": "revise", "note": "x", "refs": [{"block": "invoices", "item": "ghost", "label": "x"}]},
          "/refs/0", "is not a reply target")


def test_refs_shape_and_limits():
    payload = stored("approve-decide")
    ref = {"block": "invoices", "item": "toner", "label": "Toner"}
    fails(payload, {"decision": "revise", "note": "x", "refs": [dict(ref, label="x" * 121)]}, "/refs/0/label", "1-120")
    fails(payload, {"decision": "revise", "note": "x", "refs": [dict(ref, extra=1)]}, "/refs/0/extra", "unknown field")
    fails(payload, {"decision": "revise", "note": "x", "refs": [{"block": "invoices", "label": "x"}]}, "/refs/0/item", "required")
    fails(payload, {"decision": "revise", "note": "x", "refs": [ref, dict(ref)]}, "/refs/1", "repeats")
    fails(payload, {"decision": "revise", "note": "x", "refs": {"a": 1}}, "/refs", "must be an array")
    many = [{"block": "invoices", "item": "toner", "label": f"Toner {n}"} for n in range(21)]
    fails(payload, {"decision": "revise", "note": "x", "refs": many}, "/refs", "at most 20")


# --- pick --------------------------------------------------------------------------


def test_none_of_these_only_where_the_pick_allows_it():
    fails(stored("choose"), {"decision": "revise", "note": "Neither day works."}, "/decision", "must be one of choose")
    assert validate_result(stored("choose-none"), {"decision": "revise", "note": "Neither day works."})["decision"] == "revise"


def test_pick_choice_is_an_option_id():
    payload = stored("choose")
    data = validate_result(payload, {"decision": "choose", "blocks": {"date": {"choice": "fri"}}})
    assert result_summary(payload, data) == "choose fri"
    fails(payload, {"decision": "choose", "blocks": {"date": {"choice": "sat"}}},
          "/blocks/date/choice", "must be one of thu, fri")
    fails(payload, {"decision": "choose", "blocks": {"date": {}}}, "/blocks/date/choice", "required")


# --- post ------------------------------------------------------------------------------


def test_auto_post_approves_the_included_platforms():
    payload = stored("approve-post")
    answer = {"post": {"platforms": [{"platform": "x", "included": True}, {"platform": "linkedin", "included": False}]}}
    data = validate_result(payload, {"decision": "approve", "blocks": answer})
    assert result_summary(payload, data) == "approve · x"
    fails(payload, {"decision": "approve", "blocks": {"post": {"platforms": [
        {"platform": "x", "included": False}, {"platform": "linkedin", "included": False}]}}},
        "/blocks/post/platforms", "at least one platform included")
    fails(payload, {"decision": "approve", "blocks": {"post": {"platforms": [{"platform": "x", "included": True}]}}},
          "/blocks/post/platforms", "missing: linkedin")
    fails(payload, {"decision": "approve", "blocks": {"post": {"platforms": [
        {"platform": "x", "choice": "posted"}, {"platform": "linkedin", "included": True}]}}},
        "/blocks/post/platforms/0/choice", "unknown field")


def test_auto_post_answer_is_checked_for_structure_only():
    """Limits are the page's gate (count.js): a long text is no server error."""
    long = "word " * 700  # 3500 code points: over LinkedIn's 3000
    payload = report("approve", [dict(POST, text=long.strip(), platforms=["x", "linkedin", "instagram"])])
    every = {"post": {"platforms": [{"platform": p, "included": True} for p in ("x", "linkedin", "instagram")]}}
    data = validate_result(payload, {"decision": "approve", "blocks": every})
    assert result_summary(payload, data) == "approve · x, linkedin, instagram"
    fails(payload, {"decision": "approve", "blocks": {"post": {"platforms": [
        {"platform": "x", "included": True}, {"platform": "linkedin", "included": True},
        {"platform": "facebook", "included": True}]}}},
        "/blocks/post/platforms/2/platform", "is not a platform of this block")


def test_manual_post_ignores_limits():
    long = "word " * 700
    payload = report("do", [dict(POST, text=long.strip(), hashtags=["a", "b", "c", "d", "e", "f"],
                                 platforms=["linkedin", "instagram"])])
    answer = {"post": {"platforms": [{"platform": "linkedin", "choice": "posted"}, {"platform": "instagram", "choice": "skipped"}]}}
    data = validate_result(payload, {"decision": "submit", "blocks": answer})
    assert result_summary(payload, data) == "submit · linkedin posted, instagram skipped"
    fails(payload, {"decision": "submit", "blocks": {"post": {"platforms": [{"platform": "linkedin", "choice": "posted"}]}}},
          "/blocks/post/platforms", "missing: instagram")
    fails(payload, {"decision": "submit", "blocks": {"post": {"platforms": [
        {"platform": "linkedin", "choice": "done"}, {"platform": "instagram", "choice": "skipped"}]}}},
        "/blocks/post/platforms/0/choice", "must be one of posted, skipped")


# --- summaries ----------------------------------------------------------------------------


@pytest.mark.parametrize("name, data, summary", [
    ("read", {"decision": "read"}, "read"),
    ("review", {"decision": "accept"}, "accept"),
    ("review", {"decision": "revise", "note": "x"}, "revise"),
    ("approve", {"decision": "approve"}, "approve"),
    ("approve", {"decision": "reject"}, "reject"),
    ("do", {"decision": "done"}, "done"),
    ("do", {"decision": "skipped"}, "skipped"),
    ("choose", {"decision": "choose", "blocks": {"date": {"choice": "thu"}}}, "choose thu"),
    ("choose-none", {"decision": "revise", "note": "None of these."}, "revise"),
    ("approve-decide", {"decision": "submit", "blocks": rows("approve", "later", "approve")}, "submit · 2 approve, 1 later"),
    ("approve-decide", {"decision": "submit", "blocks": rows("later", "approve", "reject")}, "submit · 1 approve, 1 reject, 1 later"),
    ("approve-post", {"decision": "approve", "blocks": {"post": {"platforms": [
        {"platform": "x", "included": True}, {"platform": "linkedin", "included": True}]}}}, "approve · x, linkedin"),
    ("approve-post", {"decision": "reject"}, "reject"),
    ("do-post", {"decision": "submit", "blocks": {"b1": {"platforms": [
        {"platform": "instagram", "choice": "posted"}, {"platform": "facebook", "choice": "skipped"}]}}},
     "submit · instagram posted, facebook skipped"),
])
def test_summary_lines(name, data, summary):
    payload = stored(name)
    assert result_summary(payload, validate_result(payload, data)) == summary


def test_summary_of_an_unreadable_result_is_none():
    payload = stored("approve-decide")
    assert result_summary(payload, {"decision": "submit", "blocks": {"invoices": "x"}}) is None
    assert result_summary(payload, None) is None
    assert result_summary(payload, {"acknowledged": True}) is None
