"""The payload examples a bot or a person copies from the docs are accepted
by the desk as written."""
import json
import re
from pathlib import Path

from core.envelope import validate_payload

ROOT = Path(__file__).resolve().parents[1]
DOCS = ("README.md", "skills/grokbot-desk/SKILL.md", "docs/REFERENCE.md")
SCHEMA = "grokbot-desk/payload@2"


def payload_examples(name):
    text = (ROOT / name).read_text(encoding="utf-8")
    for block in re.findall(r"```json\n(.*?)\n```", text, re.S):
        try:
            value = json.loads(block)
        except ValueError:
            continue
        if isinstance(value, dict) and value.get("schema") == SCHEMA:
            yield value


def test_readme_and_skill_each_show_a_payload():
    for name in ("README.md", "skills/grokbot-desk/SKILL.md"):
        assert list(payload_examples(name)), f"{name} shows no complete payload"


def test_every_payload_example_in_the_docs_is_accepted():
    for name in DOCS:
        for example in payload_examples(name):
            validate_payload(example)
