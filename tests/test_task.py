"""The optional payload `task`: validation, kind derivation from template and
actor, the kind setting the actor, and the task the page receives."""
import json
from pathlib import Path

import pytest

from core.envelope import EnvelopeError, validate_payload
from core.registry import scan_registry
from core.tasks import KINDS, derive_kind, split_why, task_view


ROOT = Path(__file__).resolve().parents[1]
BUILTIN = ROOT / "templates" / "builtin"
REGISTRY = scan_registry(ROOT / "templates")


def fixture(template, name):
    raw = (BUILTIN / template / "fixtures" / f"{name}.json").read_text(encoding="utf-8")
    return json.loads(raw.replace("%RS_TEMPLATE%", str(BUILTIN / template).replace("\\", "\\\\")))


def envelope(template, data, **extra):
    return {
        "schema": "report-shell/payload@1",
        "template": template,
        "version": 1,
        "bot": "example-bot",
        "title": "Task test",
        "created": "2026-10-11T09:00:00+02:00",
        "data": data,
        **extra,
    }


def rejected(template, data, task):
    with pytest.raises(EnvelopeError) as caught:
        validate_payload(envelope(template, data, task=task), REGISTRY)
    return caught.value


DERIVED = {
    ("_starter", "golden"): "review",
    ("approve-one", "golden"): "approve_bot_acts",
    ("approve-one", "edge-minimal"): "approve_bot_acts",
    ("decide-list", "golden"): "approve_bot_acts",
    ("decide-list", "edge-replies"): "post_yourself",
    ("pick-option", "golden"): "pick",
    ("preview-post", "golden"): "approve_bot_acts",
    ("preview-post", "edge-max"): "approve_bot_acts",
    ("review-doc", "golden"): "review",
}


@pytest.mark.parametrize(("template", "name"), sorted(DERIVED))
def test_fixtures_derive_their_kind(template, name):
    assert derive_kind(template, fixture(template, name)) == DERIVED[(template, name)]


@pytest.mark.parametrize(("template", "data", "kind"), [
    ("preview-post", {"platforms": [{"platform": "x", "mode": "manual"}]}, "post_yourself"),
    ("preview-post", {"platforms": [{"platform": "x", "mode": "manual"}, {"platform": "linkedin"}]}, "approve_bot_acts"),
    ("preview-post", {"platforms": ["x"]}, "approve_bot_acts"),
    ("decide-list", {"items": [{"actor": "user"}, {"actor": "user"}]}, "post_yourself"),
    ("decide-list", {"items": [{"actor": "user"}, {}]}, "approve_bot_acts"),
    ("approve-one", {"actor": "user"}, "post_yourself"),
    ("approve-one", {"actor": "none"}, "fyi"),
    ("approve-one", {"actor": "bot", "action": "send"}, "approve_bot_acts"),
    ("review-doc", {}, "review"),
    ("review-doc", {"actor": "none"}, "fyi"),
    ("review-doc", {"actor": "user"}, "post_yourself"),
    ("review-doc", {"action": "post"}, "approve_bot_acts"),
    ("pick-option", {}, "pick"),
    ("shop-list", {}, "review"),
])
def test_derivation_table(template, data, kind):
    assert derive_kind(template, data) == kind


def test_existing_payloads_validate_without_task():
    for template in ("approve-one", "decide-list", "pick-option", "preview-post", "review-doc", "_starter"):
        validated = validate_payload(envelope(template, fixture(template, "golden")), REGISTRY)
        assert "task" not in validated


def test_a_full_task_validates_and_is_kept():
    task = {
        "kind": "post_yourself",
        "steps": "Copy text, open post, paste, mark posted",
        "eta_min": 3,
        "due": "2026-10-11T15:00:00+02:00",
        "why": "The ferry account answered our question. A short thank-you keeps the thread warm.",
    }
    data = fixture("decide-list", "edge-replies")
    validated = validate_payload(envelope("decide-list", data, task=task), REGISTRY)
    assert validated["task"] == task
    assert validate_payload(envelope("decide-list", data, task={"kind": "blocking", "due": "2026-10-12"}), REGISTRY)


@pytest.mark.parametrize(("task", "pointer"), [
    ("post", "/task"),
    ({}, "/task/kind"),
    ({"kind": "urgent"}, "/task/kind"),
    ({"kind": "review", "colour": "red"}, "/task/colour"),
    ({"kind": "review", "steps": "x" * 141}, "/task/steps"),
    ({"kind": "review", "steps": "one\ntwo"}, "/task/steps"),
    ({"kind": "review", "steps": ""}, "/task/steps"),
    ({"kind": "review", "eta_min": 0}, "/task/eta_min"),
    ({"kind": "review", "eta_min": 121}, "/task/eta_min"),
    ({"kind": "review", "eta_min": True}, "/task/eta_min"),
    ({"kind": "review", "eta_min": 2.5}, "/task/eta_min"),
    ({"kind": "review", "due": "tomorrow"}, "/task/due"),
    ({"kind": "review", "due": "2026-10-11T15:00:00"}, "/task/due"),
    ({"kind": "review", "due": "2026-13-01"}, "/task/due"),
    ({"kind": "review", "why": "x" * 361}, "/task/why"),
    ({"kind": "review", "why": "One. Two. Three. Four."}, "/task/why"),
])
def test_invalid_task_is_rejected_with_a_pointer(task, pointer):
    error = rejected("review-doc", fixture("review-doc", "golden"), task)
    assert error.pointer == pointer


def test_unknown_kind_names_the_allowed_kinds():
    error = rejected("review-doc", fixture("review-doc", "golden"), {"kind": "urgent"})
    assert all(kind in error.message for kind in KINDS)


@pytest.mark.parametrize(("template", "kind"), [
    ("pick-option", "review"),
    ("pick-option", "post_yourself"),
    ("approve-one", "pick"),
    ("approve-one", "review"),
    ("decide-list", "fyi"),
    ("preview-post", "pick"),
    ("review-doc", "pick"),
])
def test_a_kind_the_template_cannot_show_is_rejected(template, kind):
    error = rejected(template, fixture(template, "golden"), {"kind": kind})
    assert error.pointer == "/task/kind"


def test_a_kind_sets_the_actor_when_the_payload_leaves_it_out():
    data = fixture("approve-one", "edge-minimal")
    fyi = validate_payload(envelope("approve-one", data, task={"kind": "fyi"}), REGISTRY)
    assert fyi["data"]["actor"] == "none"
    assert data.get("actor") is None, "the caller's data is not changed"
    user = validate_payload(envelope("review-doc", fixture("review-doc", "golden"), task={"kind": "post_yourself"}), REGISTRY)
    assert user["data"]["actor"] == "user"
    bot = validate_payload(envelope("review-doc", fixture("review-doc", "golden"), task={"kind": "approve_bot_acts"}), REGISTRY)
    assert (bot["data"].get("actor", "bot"), bot["data"]["action"]) == ("bot", "continue")
    items = validate_payload(envelope("decide-list", fixture("decide-list", "golden"), task={"kind": "post_yourself"}), REGISTRY)
    assert {item["actor"] for item in items["data"]["items"]} == {"user"}
    posts = validate_payload(envelope("preview-post", fixture("preview-post", "edge-max"), task={"kind": "post_yourself"}), REGISTRY)
    assert [entry["mode"] for entry in posts["data"]["platforms"]] == ["manual"] * 4


@pytest.mark.parametrize(("template", "data", "kind", "pointer"), [
    ("approve-one", {"summary": "Ship it?", "actor": "bot"}, "fyi", "/data/actor"),
    ("approve-one", {"summary": "Ship it?", "actor": "user"}, "approve_bot_acts", "/data/actor"),
    ("review-doc", {"format": "text", "doc": "Hello", "action": "post"}, "review", "/data/action"),
    ("decide-list", {"items": [{"id": "a", "title": "A", "actor": "bot"}]}, "post_yourself", "/data/items/0/actor"),
    ("decide-list", {"items": [{"id": "a", "title": "A", "actor": "user"}]}, "approve_bot_acts", "/data/items"),
    ("preview-post", None, "post_yourself", "/data/platforms/1/mode"),
])
def test_a_kind_that_contradicts_the_actor_is_rejected(template, data, kind, pointer):
    if data is None:
        data = dict(fixture("preview-post", "golden"))
    error = rejected(template, data, {"kind": kind})
    assert error.pointer == pointer


def test_blocking_keeps_the_underlying_kind():
    validated = validate_payload(envelope("pick-option", fixture("pick-option", "golden"), task={"kind": "blocking"}), REGISTRY)
    view = task_view(validated, REGISTRY)
    assert (view["kind"], view["base"]) == ("blocking", "pick")


def test_split_why_keeps_three_sentences_and_folds_the_rest():
    assert split_why("One. Two? Three! Four. Five.") == ("One. Two? Three!", "Four. Five.")
    assert split_why("Short one.") == ("Short one.", "")
    assert split_why("") == ("", "")


def test_task_view_defaults_why_to_the_template_summary_and_says_where_it_came_from():
    approve = task_view(envelope("approve-one", fixture("approve-one", "golden")), REGISTRY)
    assert approve["kind"] == "approve_bot_acts"
    assert approve["why"] == fixture("approve-one", "golden")["summary"]
    assert approve["why_from"] == "summary"
    assert approve["verb"] == "continue"
    listing = task_view(envelope("decide-list", fixture("decide-list", "golden")), REGISTRY)
    assert listing["why_from"] == "intro"
    post = task_view(envelope("preview-post", fixture("preview-post", "golden")), REGISTRY)
    assert (post["why_from"], post["verb"]) == ("notes", "post")
    pick = task_view(envelope("pick-option", fixture("pick-option", "golden")), REGISTRY)
    assert pick["why_from"] == "context"
    starter = task_view(envelope("_starter", fixture("_starter", "golden")), REGISTRY)
    assert (starter["kind"], starter["why"], starter["why_from"]) == ("review", "", None)


def test_task_view_prefers_the_payload_why_and_folds_a_long_default():
    data = dict(fixture("approve-one", "golden"), summary="One. Two. Three. Four is folded.")
    view = task_view(envelope("approve-one", data), REGISTRY)
    assert (view["why"], view["why_more"]) == ("One. Two. Three.", "Four is folded.")
    own = task_view(envelope("approve-one", data, task={"kind": "approve_bot_acts", "why": "Because."}), REGISTRY)
    assert (own["why"], own["why_more"], own["why_from"]) == ("Because.", "", None)


def test_a_default_why_with_a_link_stays_in_the_template():
    data = dict(fixture("approve-one", "golden"), summary="See https://example.org/notes first.")
    view = task_view(envelope("approve-one", data), REGISTRY)
    assert (view["why"], view["why_from"]) == ("", None)


def test_run_detail_and_summary_carry_the_task(tmp_path):
    from core.actionlog import ActionLog
    from core.paths import ensure_layout, load_config
    from core.runs import RunStore

    data_dir = ensure_layout(tmp_path / "data")
    store = RunStore(data_dir, REGISTRY, load_config(data_dir), ActionLog(data_dir))
    payload = validate_payload(envelope("approve-one", fixture("approve-one", "edge-minimal"), task={"kind": "fyi", "eta_min": 2}), REGISTRY)
    detail = store.register(payload)
    assert detail["task"]["kind"] == "fyi"
    assert detail["task"]["eta_min"] == 2
    assert store.summaries({})[0]["task"] == {"kind": "fyi", "base": "fyi"}
