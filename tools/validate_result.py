#!/usr/bin/env python3
"""Validate one observed result before a C10 timing sample stops."""
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core.schema import SchemaError, validate


def main():
    try:
        request = json.load(sys.stdin)
        template = request["template"]
        matches = list(ROOT.glob(f"templates/*/{template}/result.schema.json"))
        if len(matches) != 1:
            raise ValueError(f"expected one result schema for {template}, got {len(matches)}")
        schema = json.loads(matches[0].read_text(encoding="utf-8"))
        result = request["result"]
        validate(result["data"], schema)
        expected = request.get("expected")
        if expected is not None and result["data"] != expected:
            raise ValueError("result data differs from fixtures/expect")
    except (json.JSONDecodeError, KeyError, OSError, SchemaError, TypeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print('{"ok":true}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
