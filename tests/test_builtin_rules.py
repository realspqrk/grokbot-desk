"""Rules a JSON Schema cannot state, checked at show: decide-list choice
labels must differ per item, and an item's due date must be a real day."""
from pathlib import Path

import pytest

from core.envelope import EnvelopeError, validate_payload
from core.registry import scan_registry
from core.rules import check_data
from core.schema import SchemaError


ROOT = Path(__file__).resolve().parents[1]
REGISTRY = scan_registry(ROOT / "templates")


def show(data):
    return validate_payload({
        "schema": "report-shell/payload@1",
        "template": "decide-list",
        "version": 1,
        "bot": "example-bot",
        "title": "Invoices",
        "created": "2026-10-11T09:00:00+02:00",
        "data": data,
    }, REGISTRY)


def pointer(data):
    with pytest.raises(SchemaError) as caught:
        check_data("decide-list", data)
    return caught.value.pointer


def item(**extra):
    return {"id": "hosting", "title": "Hosting invoice", **extra}


@pytest.mark.parametrize(("data", "where"), [
    ({"items": [item(labels={"approve": "Pay", "reject": "Pay"})]}, "/items/0/labels/reject"),
    ({"items": [item(labels={"approve": "pay ", "reject": "Pay"})]}, "/items/0/labels/reject"),
    ({"labels": {"approve": "Pay"}, "items": [item(), item(id="fee", labels={"reject": "Pay"})]}, "/items/1/labels/reject"),
    ({"labels": {"approve": "Pay", "defer": "Pay"}, "items": [item()]}, "/labels/defer"),
    ({"items": [item(labels={"approve": "Reject"})]}, "/items/0/labels/approve"),
    ({"items": [item(labels={"defer": "Ablehnen"})]}, "/items/0/labels/defer"),
    ({"items": [item(labels={"approve": "Reject", "reject": "Approve"})]}, "/items/0/labels/approve"),
    ({"labels": {"approve": "Ablehnen", "reject": "Freigeben"}, "items": [item()]}, "/labels/approve"),
    ({"items": [item(choices=["approve", "reject"], labels={"approve": "Defer"})]}, "/items/0/labels/approve"),
])
def test_duplicate_effective_labels_are_rejected(data, where):
    assert pointer(data) == where


@pytest.mark.parametrize("data", [
    {"items": [item(labels={"approve": "Pay", "reject": "Don't pay", "defer": "Next week"})]},
    {"items": [item(labels={"approve": "Approve"})]},
    {"labels": {"approve": "Pay", "reject": "Pay"}, "items": [item(choices=["approve"])]},
    {"items": [{"id": "reply", "title": "Reply", "actor": "user"}]},
])
def test_distinct_labels_pass(data):
    check_data("decide-list", data)


def test_a_due_date_must_be_a_real_day():
    assert pointer({"items": [item(due="2026-10-31"), item(id="fee", due="2026-02-31")]}) == "/items/1/due"
    assert pointer({"items": [item(due="2025-02-29")]}) == "/items/0/due"
    check_data("decide-list", {"items": [item(due="2028-02-29")]})


def test_show_rejects_with_the_data_pointer():
    with pytest.raises(EnvelopeError) as caught:
        show({"items": [item(labels={"approve": "Pay", "reject": "Pay"})]})
    assert caught.value.pointer == "/data/items/0/labels/reject"
    with pytest.raises(EnvelopeError) as caught:
        show({"items": [item(due="2026-02-31")]})
    assert caught.value.pointer == "/data/items/0/due"
    assert show({"items": [item(due="2026-02-28")]})["data"]["items"][0]["due"] == "2026-02-28"


def test_task_kind_runs_first_so_dropped_bot_labels_do_not_count():
    payload = {"items": [item(labels={"approve": "Reject"})]}
    with pytest.raises(EnvelopeError):
        show(payload)
    shown = validate_payload({
        "schema": "report-shell/payload@1", "template": "decide-list", "version": 1,
        "bot": "example-bot", "title": "Replies", "created": "2026-10-11T09:00:00+02:00",
        "task": {"kind": "post_yourself"}, "data": payload,
    }, REGISTRY)
    assert shown["data"]["items"][0]["actor"] == "user"


@pytest.mark.parametrize(("data", "where"), [
    ({"items": [item(labels={"approve": 3})]}, "/items/0/labels/approve"),
    ({"labels": {"reject": ["No"]}, "items": [item()]}, "/labels/reject"),
])
def test_shapes_an_extending_schema_allows_fail_at_their_pointer(data, where):
    assert pointer(data) == where


@pytest.mark.parametrize("data", [
    {"items": ["not an item", None, 3]},
    {"items": [item(choices=["done", 7, "approve"], labels="none")]},
    {"items": "none", "labels": "none"},
])
def test_shapes_an_extending_schema_allows_are_skipped(data):
    check_data("decide-list", data)


def test_other_templates_have_no_rules():
    check_data("approve-one", {"summary": "x"})
