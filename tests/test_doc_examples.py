"""The payload examples a bot or a person copies from the docs are accepted
by the desk as written."""
import json
import re
from pathlib import Path

from core.envelope import validate_payload

ROOT = Path(__file__).resolve().parents[1]
DOCS = ("README.md", "skills/grokbot-desk/SKILL.md", "docs/REFERENCE.md")
FENCE = re.compile(r"```json\n(.*?)\n```", re.S)


def json_fences(name):
    """Every ```json fence, as (line number of the fence, parsed value)."""
    text = (ROOT / name).read_text(encoding="utf-8")
    found = []
    for match in FENCE.finditer(text):
        line = text.count("\n", 0, match.start()) + 1
        try:
            value = json.loads(match.group(1))
        except ValueError as error:
            raise AssertionError(f"{name}:{line}: JSON does not parse: {error}") from error
        found.append((line, value))
    return found


def is_payload(value):
    if not isinstance(value, dict):
        return False
    schema = value.get("schema")
    return (
        "blocks" in value
        or "ask" in value
        or (isinstance(schema, str) and schema.startswith("grokbot-desk/payload"))
    )


def payload_examples(name):
    for line, value in json_fences(name):
        if is_payload(value):
            yield line, value


def test_each_doc_shows_a_payload():
    for name in DOCS:
        assert list(payload_examples(name)), f"{name} shows no complete payload"


def test_every_json_fence_parses_and_every_payload_is_accepted():
    for name in DOCS:
        # Parsing every fence is what fails a broken example, payload or not.
        fences = json_fences(name)
        for line, example in fences:
            if not is_payload(example):
                continue
            try:
                validate_payload(example)
            except ValueError as error:
                raise AssertionError(f"{name}:{line}: {error}") from error
