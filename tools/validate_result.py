#!/usr/bin/env python3
"""Validate one observed result before a C10 timing sample stops."""
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core.envelope import validate_payload  # noqa: E402
from core.payload import EnvelopeError, ResultError, validate_result  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures" / "payloads"


def check(fixture, result, expected=None):
    """The result envelope answers the payload fixture; with `expected`, its
    data equals the fixture's expect file. Raises ValueError otherwise."""
    if not isinstance(fixture, str) or "/" in fixture or "\\" in fixture:
        raise ValueError("fixture must be a payload fixture name")
    path = FIXTURES / f"{fixture}.json"
    payload = validate_payload(json.loads(path.read_text(encoding="utf-8")))
    if result.get("schema") != "grokbot-desk/result@2":
        raise ValueError("result schema must be grokbot-desk/result@2")
    data = validate_result(payload, result["data"])
    if data != result["data"]:
        raise ValueError("result data is not in normalized form")
    if expected is not None and result["data"] != expected:
        raise ValueError("result data differs from the fixture's expect file")


def main():
    try:
        request = json.load(sys.stdin)
        check(request["fixture"], request["result"], request.get("expected"))
    except (json.JSONDecodeError, KeyError, OSError, EnvelopeError, ResultError, TypeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print('{"ok":true}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
