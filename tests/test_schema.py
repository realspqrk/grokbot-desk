import json
from pathlib import Path

import pytest

from core.envelope import (
    EnvelopeError,
    validate_payload,
    validate_payload_bytes,
)
from core.jsonutil import loads
from core.registry import scan_registry
from core.schema import SchemaError, check_schema, validate


ROOT = Path(__file__).resolve().parents[1]


def test_schema_subset_reports_json_pointer():
    schema = {
        "type": "object",
        "required": ["items"],
        "additionalProperties": False,
        "properties": {
            "items": {
                "type": "array",
                "minItems": 1,
                "items": {"type": "string", "minLength": 2},
            }
        },
    }
    with pytest.raises(SchemaError, match=r"/items/0"):
        validate({"items": ["x"]}, schema)
    with pytest.raises(SchemaError, match=r"/extra"):
        validate({"items": ["ok"], "extra": True}, schema)


def test_one_of_requires_exactly_one_match():
    with pytest.raises(SchemaError) as error:
        validate(1, {"oneOf": [{"type": "number"}, {"minimum": 0}]})
    assert error.value.pointer == ""


@pytest.mark.parametrize(
    "schema",
    [
        {"type": "mystery"},
        {"required": "name"},
        {"minLength": -1},
        {"additionalProperties": "no"},
    ],
)
def test_schema_definition_rejects_malformed_keywords(schema):
    with pytest.raises(SchemaError):
        check_schema(schema)


def test_starter_fixture_contract():
    registry = scan_registry(ROOT / "templates")
    template = registry["_starter"]
    schema = json.loads((template.path / "schema.json").read_text(encoding="utf-8"))
    for fixture in sorted((template.path / "fixtures").glob("*.json")):
        data = json.loads(fixture.read_text(encoding="utf-8"))
        if fixture.name.startswith("invalid-"):
            with pytest.raises(SchemaError) as error:
                validate(data, schema)
            assert error.value.pointer
        else:
            validate(data, schema)


def valid_payload():
    return {
        "schema": "report-shell/payload@1",
        "template": "_starter",
        "version": 1,
        "bot": "example-dev-bot",
        "title": "Test report",
        "created": "2026-10-08T10:39:00+02:00",
        "data": {"message": "Hello"},
    }


def test_generated_run_id_uses_the_generic_bot_slug_without_private_rewriting():
    payload = valid_payload()
    payload["bot"] = "acme-example-bot"
    run_id = validate_payload(
        payload,
        scan_registry(ROOT / "templates"),
    )["run_id"]

    assert "-acme-example-bot-" in run_id


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("schema", "wrong"),
        ("version", 2),
        ("run_id", "bad"),
    ],
)
def test_envelope_rejects_bad_contract(field, value):
    payload = valid_payload()
    payload[field] = value
    raw = json.dumps(payload).encode()
    with pytest.raises(EnvelopeError):
        validate_payload_bytes(raw, scan_registry(ROOT / "templates"))


def test_envelope_rejects_unknown_field_and_oversize():
    registry = scan_registry(ROOT / "templates")
    payload = valid_payload()
    payload["unknown"] = True
    with pytest.raises(EnvelopeError, match="/unknown"):
        validate_payload_bytes(json.dumps(payload).encode(), registry)
    with pytest.raises(EnvelopeError, match="2 MB"):
        validate_payload_bytes(b" " * (2 * 1024 * 1024 + 1), registry)


@pytest.mark.parametrize(
    ("field", "value", "pointer"),
    [
        ("run_id", "", "/run_id"),
        ("run_id", None, "/run_id"),
        ("run_id", False, "/run_id"),
        ("created", None, "/created"),
        ("template", [], "/template"),
    ],
)
def test_envelope_rejects_present_invalid_ids_and_malformed_field_types(field, value, pointer):
    payload = valid_payload()
    payload[field] = value
    with pytest.raises(EnvelopeError) as error:
        validate_payload(payload, scan_registry(ROOT / "templates"))
    assert error.value.pointer == pointer


@pytest.mark.parametrize(
    ("field", "value", "pointer"),
    [
        ("notify", None, "/notify"),
        ("created", "9999-12-31T23:00:00+00:00", "/created"),
    ],
)
def test_finding_1_rejects_null_notify_and_unrepresentable_created(
    field, value, pointer
):
    payload = valid_payload()
    payload[field] = value
    with pytest.raises(EnvelopeError) as error:
        validate_payload(payload, scan_registry(ROOT / "templates"))
    assert error.value.pointer == pointer


def test_finding_1_rejects_expiry_outside_datetime_range():
    payload = valid_payload()
    payload["created"] = "9999-12-25T12:00:00+00:00"
    payload["expires_minutes"] = 10080
    with pytest.raises(EnvelopeError) as error:
        validate_payload(payload, scan_registry(ROOT / "templates"))
    assert error.value.pointer == "/expires_minutes"


@pytest.mark.parametrize(
    ("value", "schema"),
    [
        (True, {"const": 1}),
        (1, {"const": True}),
        (True, {"enum": [1]}),
        (1, {"enum": [True]}),
    ],
)
def test_schema_json_equality_keeps_booleans_distinct_from_numbers(value, schema):
    with pytest.raises(SchemaError):
        validate(value, schema)


def test_schema_unique_items_treats_equivalent_json_numbers_as_duplicates():
    with pytest.raises(SchemaError, match="unique"):
        validate([1, 1.0], {"type": "array", "uniqueItems": True})


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_finding_8_schema_rejects_non_finite_numbers_with_pointer(value):
    with pytest.raises(SchemaError) as error:
        validate(
            {"value": value},
            {
                "type": "object",
                "properties": {"value": {"type": "number"}},
            },
        )
    assert error.value.pointer == "/value"


@pytest.mark.parametrize(
    ("source", "pointer"),
    [
        ('{"outer":{"text":"\\ud800"}}', "/outer/text"),
        ('{"outer":{"\\udc00":"value"}}', "/outer/\\udc00"),
    ],
)
def test_finding_2_json_boundary_rejects_unpaired_surrogates_with_pointer(
    source, pointer
):
    with pytest.raises(ValueError) as error:
        loads(source)
    assert getattr(error.value, "pointer", None) == pointer
    assert loads('{"emoji":"\\ud83d\\ude00"}') == {"emoji": "😀"}


def test_finding_5_json_boundary_enforces_maximum_nesting_with_pointer():
    accepted = "[" * 64 + "0" + "]" * 64
    assert loads(accepted)
    rejected = "[" * 65 + "0" + "]" * 65
    with pytest.raises(ValueError) as error:
        loads(rejected)
    assert getattr(error.value, "pointer", None) == "/0" * 64


@pytest.mark.parametrize("bound", [10**400, -(10**400)])
def test_finding_6_schema_accepts_arbitrarily_large_integer_bounds(bound):
    check_schema({"type": "number", "minimum": bound, "maximum": bound})


@pytest.mark.parametrize("value", [1.0, 1e0, -2.0])
def test_finding_7_integer_type_accepts_finite_integer_valued_floats(value):
    assert validate(value, {"type": "integer"}) == value


@pytest.mark.parametrize(
    "value",
    [True, False, 1.5, float("nan"), float("inf"), float("-inf")],
)
def test_finding_7_integer_type_rejects_booleans_fractional_and_nonfinite(value):
    with pytest.raises(SchemaError):
        validate(value, {"type": "integer"})


@pytest.mark.parametrize(
    ("pattern", "valid"),
    [
        (r"^[a-z0-9-]{1,40}$", "golden-slug"),
        (r"^\d{4}-\d{2}-\d{2}$", "2026-10-08"),
    ],
)
@pytest.mark.parametrize("ending", ["\n", "\r\n"])
def test_pattern_end_anchor_rejects_trailing_line_endings(pattern, valid, ending):
    assert validate(valid, {"type": "string", "pattern": pattern}) == valid
    with pytest.raises(SchemaError):
        validate(valid + ending, {"type": "string", "pattern": pattern})


@pytest.mark.parametrize(
    ("pattern", "accepted", "rejected"),
    [
        (r"\$", "$", "x"),
        (r"[$]", "$", "x"),
        (r"\\$", "\\", "\\\n"),
    ],
)
def test_pattern_translation_preserves_escaped_and_character_class_dollars(
    pattern, accepted, rejected
):
    assert validate(accepted, {"type": "string", "pattern": pattern}) == accepted
    with pytest.raises(SchemaError):
        validate(rejected, {"type": "string", "pattern": pattern})
