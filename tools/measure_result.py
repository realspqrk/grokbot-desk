#!/usr/bin/env python3
"""Measure and validate C10 result round trips."""
import json
import math
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core.schema import SchemaError, validate


def main():
    process = None
    try:
        process = subprocess.run(
            ["node", str(ROOT / "tools" / "e2e.mjs"), "submit", "--all"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=300,
        )
        measured = json.loads(process.stdout.strip().splitlines()[-1])
    except (OSError, subprocess.TimeoutExpired, IndexError, json.JSONDecodeError) as error:
        measured = {"ok": False, "error": str(error), "total": 0, "cases": []}
    if not isinstance(measured, dict):
        measured = {"ok": False, "error": "submit tool returned non-object JSON", "cases": []}
    findings = []
    errors = []
    if process is None:
        errors.append(measured.get("error") or "submit tool did not run")
    elif process.returncode:
        detail = process.stderr.strip()
        errors.append(
            f"submit tool exited {process.returncode}" + (f": {detail}" if detail else "")
        )
    cases = measured.get("cases")
    if not isinstance(cases, list) or len(cases) != 20:
        errors.append(
            f"submit measurement must contain exactly 20 cases, got "
            f"{len(cases) if isinstance(cases, list) else 'invalid'}"
        )
        cases = cases if isinstance(cases, list) else []
    run_ids = [case.get("run_id") for case in cases if isinstance(case, dict)]
    if len(run_ids) != len(cases) or any(not isinstance(run_id, str) or not run_id for run_id in run_ids):
        errors.append("every submit case must have a nonempty run_id")
    elif len(set(run_ids)) != len(run_ids):
        errors.append("submit measurements must use 20 independent run_ids")
    durations = []
    for case in cases:
        if not isinstance(case, dict):
            findings.append({"run_id": None, "error": "submit case is not an object"})
            continue
        duration = case.get("ms")
        if not isinstance(duration, (int, float)) or isinstance(duration, bool) or not math.isfinite(duration) or duration < 0:
            findings.append({"run_id": case.get("run_id"), "error": "invalid measurement duration"})
        else:
            durations.append(float(duration))
        validation_epoch = case.get("validation_epoch_ms")
        observed_epoch = case.get("observed_epoch_ms")
        if not (
            case.get("validation_ok") is True
            and isinstance(validation_epoch, (int, float))
            and not isinstance(validation_epoch, bool)
            and math.isfinite(validation_epoch)
            and isinstance(observed_epoch, (int, float))
            and not isinstance(observed_epoch, bool)
            and math.isfinite(observed_epoch)
            and observed_epoch >= validation_epoch
        ):
            findings.append({
                "run_id": case.get("run_id"),
                "error": "missing timed validation evidence",
            })
        try:
            schema_path = next(
                ROOT.glob(f"templates/*/{case['template']}/result.schema.json")
            )
            schema = json.loads(schema_path.read_text(encoding="utf-8"))
            result = case["result"]
            validate(result["data"], schema)
            if case.get("expected") is not None and result["data"] != case["expected"]:
                findings.append(
                    {
                        "run_id": case["run_id"],
                        "error": "result data differs from fixtures/expect",
                        "expected": case["expected"],
                        "actual": result["data"],
                    }
                )
        except (StopIteration, OSError, KeyError, ValueError, SchemaError) as error:
            findings.append({"run_id": case.get("run_id"), "error": str(error)})
    measured["cases"] = cases
    measured["total"] = len(cases)
    measured["max_ms"] = max(durations, default=None)
    measured["validation_findings"] = findings
    if errors:
        measured["error"] = "; ".join(errors)
    measured["ok"] = (
        not errors
        and process is not None
        and process.returncode == 0
        and measured.get("ok") is True
        and len(durations) == 20
        and measured["max_ms"] <= 500
        and not findings
    )
    print(json.dumps(measured, ensure_ascii=False, separators=(",", ":")))
    return 0 if measured["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
