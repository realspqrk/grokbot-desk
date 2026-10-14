"""The payload examples a bot or a person copies from the docs are accepted
by the desk as written."""
import json
import re
from pathlib import Path

import pytest

from core.envelope import validate_payload
from core.registry import scan_registry

ROOT = Path(__file__).resolve().parents[1]
DOCS = ("README.md", "skills/grokbot-desk/SKILL.md", "docs/GUIDE.md")


def payload_examples(name):
    text = (ROOT / name).read_text(encoding="utf-8")
    for block in re.findall(r"```json\n(.*?)\n```", text, re.S):
        try:
            value = json.loads(block)
        except ValueError:
            continue  # an annotated or partial example, not a payload to copy
        if isinstance(value, dict) and value.get("schema") == "report-shell/payload@1":
            yield value


@pytest.mark.parametrize("name", DOCS)
def test_every_payload_example_in_the_docs_is_accepted(name):
    registry = scan_registry(ROOT / "templates")
    examples = list(payload_examples(name))
    if name != "docs/GUIDE.md":
        assert examples, f"{name} shows no complete payload"
    for example in examples:
        validate_payload(example, registry)
