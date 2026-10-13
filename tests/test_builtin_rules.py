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
])
def test_duplicate_effective_labels_are_rejected(data, where):
    assert pointer(data) == where


@pytest.mark.parametrize("data", [
    {"items": [item(labels={"approve": "Pay", "reject": "Don't pay", "defer": "Next week"})]},
    {"items": [item(labels={"approve": "Approve"})]},
    {"labels": {"approve": "Pay", "reject": "Pay"}, "items": [item(choices=["approve"])]},
    {"items": [item(choices=["approve", "reject"], labels={"approve": "Defer"})]},
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


def test_other_templates_have_no_rules():
    check_data("approve-one", {"summary": "x"})
