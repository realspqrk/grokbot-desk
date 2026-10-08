#!/usr/bin/env python3
"""Run grokbot-desk acceptance measurements and write the section 8 rubric."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIVE_WINDOW_CRITERIA = frozenset({"C1", "C2", "C3", "C4"})
LIVE_WINDOW_UNAVAILABLE = (
    "live window measurements are not part of this distribution"
)
HARD_GATES = ("C2", "C3", "C5", "C8", "C11", "C14", "C15", "C16")
POINTS = {"C1": 1.0, "C4": 1.0, "C6": 1.0, "C7": 1.0, "C9": 1.0, "C10": 0.5, "C12": 1.0, "C13": 0.5}
TARGETS = {
    "C1": "cold <=4000 ms; warm <=1500 ms",
    "C2": "20/20 own app window",
    "C3": "0 findings; 0 new browser PIDs",
    "C4": "0 extra windows; max <=1000 ms",
    "C5": "20/20 byte-equal copies",
    "C6": "100% of >=30 counter cases",
    "C7": "<=1% pixels, light and dark",
    "C8": "schema pytest 100%",
    "C9": "check --all --visual",
    "C10": "20 results; max <=500 ms",
    "C11": "safety pytest 100%",
    "C12": "keyboard 100%",
    "C13": "0 axe serious/critical + basic/contrast",
    "C14": "0 external; CSP every response",
    "C15": "stdlib + German strings + Vienna time",
    "C16": "calm: 13 K-items on every scene",
}


def calculate_points(criterion, raw):
    if raw.get("measurement_valid") is False:
        return 0.0
    if criterion == "C1":
        return 0.5 * (bool(raw.get("cold_pass")) + bool(raw.get("warm_pass")))
    if criterion == "C6":
        if raw.get("total", 0) < 30:
            return 0.0
        ratio = raw.get("ratio", 0)
        return 1.0 if ratio == 1 else 0.5 if ratio >= 0.95 else 0.0
    if criterion == "C7":
        return 0.5 * (bool(raw.get("light_pass")) + bool(raw.get("dark_pass")))
    return POINTS.get(criterion, 0.0) if raw.get("pass") else 0.0


def score_totals(criteria, usability_points):
    automated = round(sum(float(item.get("points", 0)) for item in criteria.values()), 3)
    failed = [name for name in HARD_GATES if criteria.get(name, {}).get("status") == "fail"]
    pending = [name for name in HARD_GATES if criteria.get(name, {}).get("status") == "not run"]
    uncapped = round(automated + float(usability_points or 0), 3)
    return {
        "automated": automated,
        "usability": usability_points,
        "uncapped": uncapped,
        "total": min(5.0, uncapped) if failed else uncapped,
        "cap_applied": bool(failed and uncapped > 5),
        "failed_gates": failed,
        "pending_gates": pending,
    }


def _run(command, timeout=300):
    try:
        result = subprocess.run(
            command,
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
        output = result.stdout.strip()
        parsed = None
        if output:
            try:
                parsed = json.loads(output.splitlines()[-1])
            except json.JSONDecodeError:
                pass
        return {
            "returncode": result.returncode,
            "stdout": output,
            "stderr": result.stderr.strip(),
            "json": parsed,
        }
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"returncode": -1, "stdout": "", "stderr": str(error), "json": None}


def _command_json(command, timeout=300):
    result = _run(command, timeout)
    body = result["json"]
    if body is None:
        body = {"ok": False, "error": result["stderr"] or result["stdout"] or "tool returned no JSON"}
    body["_process"] = {key: result[key] for key in ("returncode", "stderr")}
    if result["returncode"] and body.get("ok"):
        body["ok"] = False
        body["error"] = result["stderr"] or f"tool exited {result['returncode']}"
    return body


def _pytest(file):
    result = _run(["py", "-3", "-m", "pytest", "-q", file], timeout=180)
    return {
        "ok": result["returncode"] == 0,
        "returncode": result["returncode"],
        "output": "\n".join(item for item in (result["stdout"], result["stderr"]) if item),
    }


def _entry(status, value, raw, criterion):
    summary = dict(raw)
    summary.setdefault("pass", status == "pass")
    points = calculate_points(criterion, summary) if status != "not run" else 0.0
    return {
        "status": status,
        "value": value,
        "target": TARGETS[criterion],
        "points": points,
        "max_points": POINTS.get(criterion, 0.0),
        "raw": raw,
    }


def _not_run(criterion, reason):
    return _entry("not run", reason, {"reason": reason}, criterion)


def _error(raw):
    return raw.get("error") or raw.get("_process", {}).get("stderr") or "tool failed"


def _usability():
    files = list((ROOT / "docs" / "scores").glob("usability-*.json"))
    if not files:
        return {"status": "pending (manual review)", "points": 0.0, "file": None, "raw": None}
    newest = max(files, key=lambda item: item.stat().st_mtime)
    try:
        raw = json.loads(newest.read_text(encoding="utf-8"))
        values = [float(raw.get(f"U{index}", 0)) for index in range(1, 7)]
        if any(value < 0 or value > 0.5 for value in values):
            raise ValueError("usability values must be between 0 and 0.5")
        return {
            "status": "provisional" if raw.get("provisional") else "human-reviewed",
            "points": sum(values),
            "file": str(newest.relative_to(ROOT)),
            "raw": raw,
        }
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        return {"status": f"invalid: {error}", "points": 0.0, "file": str(newest.relative_to(ROOT)), "raw": None}


def _visual_summary(raw):
    results = raw.get("results", [])
    themes = {}
    for theme in ("light", "dark"):
        selected = [item for item in results if item.get("theme") == theme]
        themes[theme] = bool(selected) and all(item.get("pass") for item in selected)
    return themes


def _complete_cases(raw):
    cases = raw.get("cases")
    total = raw.get("total")
    return (
        isinstance(cases, list)
        and isinstance(total, int)
        and total > 0
        and len(cases) == total
        and all(isinstance(item, dict) for item in cases)
    )


def _selected_port(args=None):
    selected = getattr(args, "port", None) if args is not None else None
    selected = selected if selected is not None else os.environ.get("RS_TOOL_PORT", "18920")
    try:
        port = int(selected)
    except (TypeError, ValueError) as error:
        raise ValueError("--port/RS_TOOL_PORT must be an integer") from error
    if port == 18742:
        raise ValueError(f"port {port} is reserved")
    if not 18920 <= port <= 18939:
        raise ValueError("--port/RS_TOOL_PORT must be in the isolated range 18920-18939")
    return port


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _list_of(value, validator):
    return isinstance(value, list) and all(validator(item) for item in value)


def _valid_motion(raw, *, reduced):
    return (
        isinstance(raw, dict)
        and raw.get("reduced_motion") is reduced
        and _list_of(raw.get("motion"), lambda item: (
            isinstance(item, dict)
            and isinstance(item.get("identity"), str)
            and _number(item.get("max_ms"))
        ))
        and _number(raw.get("max_ms"))
        and _list_of(raw.get("attention"), lambda item: isinstance(item, str))
    )


def _valid_k_raw(name, raw, *, open_runs, measured_k9, screenshot_k7):
    if not isinstance(raw, dict):
        return False
    if name == "K1":
        disabled = raw.get("disabled_primary")
        return (
            _list_of(raw.get("primary_ids"), lambda item: isinstance(item, str))
            and _list_of(raw.get("accent_fill_ids"), lambda item: isinstance(item, str))
            and (
                disabled is None
                or (
                    isinstance(disabled, dict)
                    and all(
                        isinstance(disabled.get(key), bool)
                        for key in ("opaque", "neutral", "neutral_aa")
                    )
                    and _number(disabled.get("contrast"))
                )
            )
        )
    if name == "K2":
        return _list_of(raw.get("items"), lambda item: (
            isinstance(item, dict)
            and isinstance(item.get("identity"), str)
            and isinstance(item.get("interactive_count"), int)
            and not isinstance(item.get("interactive_count"), bool)
            and _list_of(
                item.get("non_icon_copy_controls"),
                lambda control: isinstance(control, str),
            )
        ))
    if name == "K3":
        return (
            raw.get("open_runs") == open_runs
            and isinstance(raw.get("rail_rendered"), bool)
            and _number(raw.get("rail_width"))
            and isinstance(raw.get("focusable_descendants"), int)
            and not isinstance(raw.get("focusable_descendants"), bool)
        )
    if name == "K4":
        return (
            _list_of(raw.get("font_sizes"), _number)
            and _list_of(raw.get("font_weights"), lambda item: isinstance(item, str))
        )
    if name == "K5":
        return (
            _list_of(raw.get("boxes"), lambda item: (
                isinstance(item, dict)
                and isinstance(item.get("identity"), str)
                and isinstance(item.get("ancestors"), int)
                and not isinstance(item.get("ancestors"), bool)
            ))
            and _number(raw.get("max_box_ancestors"))
        )
    if name == "K6":
        return (
            (raw.get("accent_hue") is None or _number(raw.get("accent_hue")))
            and _list_of(raw.get("off_accent"), lambda item: (
                isinstance(item, dict)
                and isinstance(item.get("identity"), str)
                and isinstance(item.get("property"), str)
                and _number(item.get("hue"))
            ))
        )
    if name == "K7":
        ratio = raw.get("background_ratio")
        return (
            _list_of(raw.get("item_gaps"), _number)
            and _list_of(raw.get("wide_text"), lambda item: (
                isinstance(item, dict)
                and isinstance(item.get("identity"), str)
                and _number(item.get("width"))
                and _number(item.get("max_width"))
            ))
            and _list_of(raw.get("page_background"), _number)
            and len(raw["page_background"]) == 3
            and (ratio is None or _number(ratio))
            and (not screenshot_k7 or _number(ratio))
            and raw.get("lint_pass") in (None, True, False)
        )
    if name == "K8":
        return (
            _list_of(raw.get("visible_inputs"), lambda item: isinstance(item, str))
            and _list_of(raw.get("open_secondary"), lambda item: isinstance(item, str))
        )
    if name == "K9":
        return (
            raw.get("measured") is measured_k9
            and isinstance(raw.get("visible_interactive_above_fold"), int)
            and not isinstance(raw.get("visible_interactive_above_fold"), bool)
        )
    if name == "K10":
        interaction = raw.get("interaction")
        return (
            _list_of(raw.get("mockups"), lambda item: (
                isinstance(item, dict)
                and isinstance(item.get("identity"), str)
                and _number(item.get("width"))
            ))
            and _list_of(raw.get("tablists"), lambda item: (
                isinstance(item, dict)
                and item.get("kind") in ("tablist", "segmented")
                and isinstance(item.get("tabs"), int)
                and isinstance(item.get("stateful_tabs"), int)
            ))
            and (
                interaction is None
                or (
                    isinstance(interaction, dict)
                    and interaction.get("kind") in (None, "tablist", "segmented")
                    and all(
                        isinstance(interaction.get(key), int)
                        and not isinstance(interaction.get(key), bool)
                        for key in ("controls", "stateful_controls", "reachable_controls")
                    )
                    and isinstance(interaction.get("single_mockup_each"), bool)
                )
            )
        )
    if name == "K11":
        return (
            _list_of(raw.get("noise"), lambda item: isinstance(item, str))
            and isinstance(raw.get("header_titles"), int)
            and not isinstance(raw.get("header_titles"), bool)
            and _list_of(raw.get("header_controls"), lambda item: isinstance(item, str))
        )
    if name == "K12":
        return (
            _valid_motion(raw.get("normal"), reduced=False)
            and _valid_motion(raw.get("reduced"), reduced=True)
        )
    if name == "K13":
        copy_focus = raw.get("copy_focus")
        keyboard = raw.get("keyboard")
        accessibility = raw.get("accessibility")
        controls_valid = _list_of(copy_focus.get("controls"), lambda item: (
            isinstance(item, dict)
            and isinstance(item.get("selector"), str)
            and isinstance(item.get("expected_identity"), str)
            and (
                item.get("actual_identity") is None
                or isinstance(item.get("actual_identity"), str)
            )
            and isinstance(item.get("focused"), bool)
            and isinstance(item.get("copy_control"), bool)
            and isinstance(item.get("visible"), bool)
            and (
                not item["focused"]
                or (
                    _number(item.get("outline_width"))
                    and isinstance(item.get("outline_style"), str)
                )
            )
        )) if isinstance(copy_focus, dict) else False
        return (
            isinstance(copy_focus, dict)
            and isinstance(copy_focus.get("pass"), bool)
            and controls_valid
            and isinstance(keyboard, dict)
            and isinstance(keyboard.get("pass"), bool)
            and (keyboard.get("error") is None or isinstance(keyboard.get("error"), str))
            and isinstance(accessibility, dict)
            and isinstance(accessibility.get("pass"), bool)
            and isinstance(accessibility.get("unnamed"), int)
            and isinstance(accessibility.get("positive_tabindex"), int)
            and _list_of(
                accessibility.get("violations"),
                lambda item: isinstance(item, str),
            )
            and isinstance(raw.get("dependency"), str)
        )
    return False


def _valid_calm_result(result):
    process_code = result.get("_process", {}).get("returncode")
    if (
        result.get("mode") != "calm"
        or result.get("total") != 13
        or process_code not in (0, 1)
        or (process_code == 0) is not (result.get("ok") is True)
    ):
        return False
    coverage = result.get("coverage", {})
    if coverage.get("expected") != 2 or coverage.get("executed") != 2:
        return False
    template = result.get("template")
    if not isinstance(template, str) or not template:
        return False
    coverage_templates = coverage.get("templates")
    if (
        not isinstance(coverage_templates, list)
        or len(coverage_templates) != 1
        or coverage_templates[0] != {
            "template": template,
            "expected": 2,
            "executed": 2,
        }
    ):
        return False
    scenes = result.get("scenes")
    if not isinstance(scenes, list) or len(scenes) != 16:
        return False
    expected_scenes = {
        (fixture, theme, width, height, open_runs)
        for fixture in ("golden", "edge-max")
        for theme in ("light", "dark")
        for width, height in ((1500, 1000), (1280, 720))
        for open_runs in (1, 3)
    }
    actual_scenes = set()
    for scene in scenes:
        viewport = scene.get("viewport", {})
        key = (
            scene.get("fixture"),
            scene.get("theme"),
            viewport.get("width"),
            viewport.get("height"),
            scene.get("open_runs"),
        )
        actual_scenes.add(key)
        scene_items = scene.get("items")
        if (
            scene.get("template") != template
            or
            not isinstance(scene.get("ok"), bool)
            or not isinstance(scene_items, dict)
            or any(
                not isinstance(scene_items.get(f"K{index}"), dict)
                for index in range(1, 14)
            )
        ):
            return False
        if scene["ok"] is not all(
            scene_items[f"K{index}"].get("pass") is True
            for index in range(1, 14)
        ):
            return False
        expected_k9 = key[0] == "golden" and key[2:4] == (1280, 720)
        screenshot_k7 = key[0] == "golden" and key[2:4] == (1500, 1000)
        for index in range(1, 14):
            name = f"K{index}"
            item = scene_items[name]
            if (
                not isinstance(item.get("pass"), bool)
                or not _list_of(item.get("reasons"), lambda value: isinstance(value, str))
                or not _valid_k_raw(
                    name,
                    item.get("raw"),
                    open_runs=scene.get("open_runs"),
                    measured_k9=expected_k9,
                    screenshot_k7=screenshot_k7,
                )
            ):
                return False
    if actual_scenes != expected_scenes:
        return False
    items = result.get("items")
    if not isinstance(items, dict):
        return False
    for index in range(1, 14):
        name = f"K{index}"
        item = items.get(name)
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("pass"), bool)
            or not isinstance(item.get("raw"), list)
            or len(item["raw"]) != len(scenes)
        ):
            return False
        scene_pass = all(scene["items"][name].get("pass") is True for scene in scenes)
        if item["pass"] is not scene_pass:
            return False
        for scene, aggregate in zip(scenes, item["raw"]):
            expected = {
                "template": scene["template"],
                "fixture": scene["fixture"],
                "theme": scene["theme"],
                "viewport": scene["viewport"],
                "open_runs": scene["open_runs"],
                **scene["items"][name]["raw"],
            }
            if aggregate != expected:
                return False
    passed = sum(result["items"][f"K{index}"]["pass"] for index in range(1, 14))
    if result.get("passed") != passed or result.get("ok") is not (passed == 13):
        return False
    return True


def _registered_templates():
    templates = []
    for path in sorted((ROOT / "templates").glob("*/*/template.json")):
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        template_id = manifest.get("id")
        if isinstance(template_id, str) and template_id:
            templates.append(template_id)
    return sorted(set(templates))


def _allowed_browser_url(url, port):
    return isinstance(url, str) and (
        url.startswith(f"http://127.0.0.1:{port}/")
        or url.startswith("data:")
        or url.startswith("blob:")
    )


def _netlog_findings(directory, expected_runs, port):
    findings = []
    files = sorted(Path(directory).glob("*.json"))
    for run in expected_runs:
        if not run.get("logs"):
            findings.append({
                "type": "missing_network_log",
                "command": [str(item) for item in run.get("command", [])],
            })
    for file in files:
        try:
            value = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            findings.append({
                "type": "invalid_network_log",
                "file": file.name,
                "error": str(error),
            })
            continue
        requests = value.get("requests")
        responses = value.get("responses")
        if not isinstance(requests, list) or not isinstance(responses, list):
            findings.append({"type": "invalid_network_log", "file": file.name})
            continue
        for url in requests:
            if not _allowed_browser_url(url, port):
                findings.append({
                    "type": "external_request",
                    "url": url,
                    "file": file.name,
                })
        for response in responses:
            if not isinstance(response, dict):
                findings.append({"type": "invalid_network_response", "file": file.name})
                continue
            if response.get("synthetic"):
                continue
            headers = response.get("headers")
            if not isinstance(headers, dict) or not headers.get("content-security-policy"):
                findings.append({
                    "type": "missing_csp",
                    "url": response.get("url"),
                    "status": response.get("status"),
                    "file": file.name,
                })
    return findings, len(files)


def run_score(args):
    args.out.mkdir(parents=True, exist_ok=True)
    netlog_dir = Path(tempfile.mkdtemp(prefix="netlogs-", dir=args.out))
    selected_port = _selected_port(args)
    previous_netlog = os.environ.get("RS_NETLOG_DIR")
    previous_port = os.environ.get("RS_TOOL_PORT")
    os.environ["RS_NETLOG_DIR"] = str(netlog_dir)
    os.environ["RS_TOOL_PORT"] = str(selected_port)
    try:
        return _run_score(args, netlog_dir, selected_port)
    finally:
        if previous_netlog is None:
            os.environ.pop("RS_NETLOG_DIR", None)
        else:
            os.environ["RS_NETLOG_DIR"] = previous_netlog
        if previous_port is None:
            os.environ.pop("RS_TOOL_PORT", None)
        else:
            os.environ["RS_TOOL_PORT"] = previous_port


def _run_score(args, netlog_dir, selected_port):
    selected = set(args.only.split(",")) if args.only else {f"C{index}" for index in range(1, 17)}
    unknown = selected - {f"C{index}" for index in range(1, 17)}
    if unknown:
        raise ValueError(f"unknown criteria: {', '.join(sorted(unknown))}")
    criteria = {}
    copy_raw = None
    network_raw = None
    c12_raw = None
    c13_raw = None
    browser_runs = []
    def browser_logs():
        return {item.name for item in netlog_dir.glob("*.json")}

    def browser_json(command, timeout=300):
        before = browser_logs()
        raw = _command_json(command, timeout)
        created = sorted(browser_logs() - before)
        browser_runs.append({"command": command, "logs": created})
        return raw

    def browser_run(command, timeout=300):
        before = browser_logs()
        raw = _run(command, timeout)
        created = sorted(browser_logs() - before)
        browser_runs.append({"command": command, "logs": created})
        return raw

    for criterion in (f"C{index}" for index in range(1, 17)):
        if criterion not in selected:
            criteria[criterion] = _not_run(criterion, "not selected")
            continue
        if criterion in LIVE_WINDOW_CRITERIA:
            criteria[criterion] = _not_run(criterion, LIVE_WINDOW_UNAVAILABLE)
            continue
        if args.no_windows and criterion == "C5":
            criteria[criterion] = _not_run(
                criterion, "--no-windows (clipboard measurement disabled)"
            )
            continue
        if criterion == "C5":
            raw = browser_json(
                ["py", "-3", str(ROOT / "tools" / "measure_copy.py")], timeout=300
            )
            copy_raw = raw
            passed, total = raw.get("passed", 0), raw.get("total", 0)
            complete = _complete_cases(raw)
            raw = {**raw, "measurement_valid": complete}
            criteria[criterion] = _entry("pass" if raw.get("ok") and complete else "fail", f"{passed}/{total}", raw, criterion)
        elif criterion == "C6":
            raw = _command_json(["node", str(ROOT / "tools" / "counter_test.mjs")], timeout=60)
            passed, total = raw.get("passed", 0), raw.get("total", 0)
            complete = _complete_cases(raw)
            raw = {**raw, "measurement_valid": complete}
            criteria[criterion] = _entry("pass" if raw.get("ok") and complete else "fail", f"{passed}/{total}", raw, criterion)
        elif criterion == "C7":
            raw = browser_json(
                ["node", str(ROOT / "tools" / "visual.mjs"), "--check", "--all"],
                timeout=300,
            )
            themes = _visual_summary(raw)
            complete = (
                not raw.get("error")
                and isinstance(raw.get("results"), list)
                and bool(raw["results"])
                and all(
                    any(item.get("theme") == theme for item in raw["results"])
                    for theme in ("light", "dark")
                )
            )
            summary = {
                **raw,
                "light_pass": themes["light"],
                "dark_pass": themes["dark"],
                "measurement_valid": complete,
            }
            criteria[criterion] = _entry("pass" if raw.get("ok") and complete else "fail", f"light {'pass' if themes['light'] else 'fail'}; dark {'pass' if themes['dark'] else 'fail'}", summary, criterion)
        elif criterion == "C8":
            raw = _pytest("tests/test_schema.py")
            criteria[criterion] = _entry("pass" if raw["ok"] else "fail", "pytest pass" if raw["ok"] else raw["output"], raw, criterion)
        elif criterion == "C9":
            result = browser_run(
                ["py", "-3", str(ROOT / "report_shell.py"), "check", "--all", "--visual"],
                timeout=300,
            )
            raw = {"ok": result["returncode"] == 0, **result}
            criteria[criterion] = _entry("pass" if raw["ok"] else "fail", "all templates pass" if raw["ok"] else (raw["stderr"] or raw["stdout"]), raw, criterion)
        elif criterion == "C10":
            raw = browser_json(
                ["py", "-3", str(ROOT / "tools" / "measure_result.py")], timeout=300
            )
            value = f"{raw.get('total', 0)}/20; max {raw.get('max_ms', 0):.1f} ms" if raw.get("total") else _error(raw)
            criteria[criterion] = _entry("pass" if raw.get("ok") else "fail", value, raw, criterion)
        elif criterion == "C11":
            raw = _pytest("tests/test_safety.py")
            criteria[criterion] = _entry("pass" if raw["ok"] else "fail", "pytest pass" if raw["ok"] else raw["output"], raw, criterion)
        elif criterion == "C12":
            raw = browser_json(
                ["node", str(ROOT / "tools" / "e2e.mjs"), "keyboard", "--all"],
                timeout=300,
            )
            complete = _complete_cases(raw)
            raw = {**raw, "measurement_valid": complete}
            c12_raw = raw
            criteria[criterion] = _entry("pass" if raw.get("ok") and complete else "fail", f"{raw.get('passed', 0)}/{raw.get('total', 0)}", raw, criterion)
        elif criterion == "C13":
            axe = browser_json(
                ["node", str(ROOT / "tools" / "e2e.mjs"), "axe", "--all"],
                timeout=300,
            )
            basic = browser_json(
                ["node", str(ROOT / "tools" / "e2e.mjs"), "a11y-basic", "--all"],
                timeout=300,
            )
            contrast = _command_json(["py", "-3", str(ROOT / "tools" / "contrast.py")], timeout=60)
            passed = all(item.get("ok") for item in (axe, basic, contrast))
            raw = {"axe": axe, "basic": basic, "contrast": contrast, "pass": passed}
            c13_raw = raw
            value = f"{axe.get('serious_critical', '?')} serious/critical; contrast {contrast.get('passed', 0)}/{contrast.get('total', 0)}"
            criteria[criterion] = _entry("pass" if passed else "fail", value, raw, criterion)
        elif criterion == "C14":
            raw = browser_json(
                ["node", str(ROOT / "tools" / "e2e.mjs"), "network", "--all"],
                timeout=300,
            )
            network_raw = raw
            findings = list(raw.get("findings", []))
            copy_network = copy_raw.get("network") if isinstance(copy_raw, dict) else None
            c5_executed = (
                isinstance(copy_raw, dict)
                and isinstance(copy_raw.get("cases"), list)
                and bool(copy_raw["cases"])
            )
            if c5_executed and not isinstance(copy_network, dict):
                findings.append({"type": "missing_c5_network_log"})
            if isinstance(copy_network, dict):
                for url in copy_network.get("requests", []):
                    if not _allowed_browser_url(url, selected_port):
                        findings.append({"type": "external_c5_request", "url": url})
                for response in copy_network.get("responses", []):
                    if (
                        not response.get("synthetic")
                        and not response.get("headers", {}).get("content-security-policy")
                    ):
                        findings.append({
                            "type": "missing_c5_csp",
                            "url": response.get("url"),
                            "status": response.get("status"),
                        })
            raw = {
                **raw,
                "findings": findings,
                "c5_network_aggregated": isinstance(copy_network, dict),
                "ok": raw.get("ok") is True and not findings,
            }
            criteria[criterion] = _entry("pass" if raw.get("ok") else "fail", f"{len(findings)} findings", raw, criterion)
        elif criterion == "C15":
            lint = _command_json(["py", "-3", str(ROOT / "tools" / "lint_src.py")], timeout=60)
            strings = browser_json(
                ["node", str(ROOT / "tools" / "e2e.mjs"), "strings", "--all"],
                timeout=300,
            )
            rendered_time = browser_json(
                ["node", str(ROOT / "tools" / "e2e.mjs"), "time"],
                timeout=300,
            )
            timing = _pytest("tests/test_time.py")
            passed = (
                lint.get("ok") is True
                and strings.get("ok") is True
                and timing["ok"]
                and rendered_time.get("ok") is True
            )
            raw = {
                "lint": lint,
                "strings": strings,
                "time": timing,
                "rendered_time": rendered_time,
            }
            criteria[criterion] = _entry(
                "pass" if passed else "fail",
                (
                    f"install {'pass' if lint.get('ok') else 'fail'}; "
                    f"strings {'pass' if strings.get('ok') else 'fail'}; "
                    f"time {'pass' if timing['ok'] and rendered_time.get('ok') else 'fail'}"
                ),
                raw,
                criterion,
            )
        elif criterion == "C16":
            calm = {}
            for template_id in _registered_templates():
                calm[template_id] = browser_json(
                    [
                        "node",
                        str(ROOT / "tools" / "e2e.mjs"),
                        "calm",
                        template_id,
                    ],
                    timeout=300,
                )
            lint = _command_json(
                ["py", "-3", str(ROOT / "tools" / "lint_src.py"), "--calm"],
                timeout=60,
            )
            if c12_raw is None:
                keyboard = browser_json(
                    [
                        "node",
                        str(ROOT / "tools" / "e2e.mjs"),
                        "keyboard",
                        "--all",
                    ],
                    timeout=300,
                )
                c12_raw = {
                    **keyboard,
                    "measurement_valid": _complete_cases(keyboard),
                }
            if c13_raw is None:
                axe = browser_json(
                    ["node", str(ROOT / "tools" / "e2e.mjs"), "axe", "--all"],
                    timeout=300,
                )
                basic = browser_json(
                    [
                        "node",
                        str(ROOT / "tools" / "e2e.mjs"),
                        "a11y-basic",
                        "--all",
                    ],
                    timeout=300,
                )
                contrast = _command_json(
                    ["py", "-3", str(ROOT / "tools" / "contrast.py")],
                    timeout=60,
                )
                c13_raw = {
                    "axe": axe,
                    "basic": basic,
                    "contrast": contrast,
                    "pass": all(
                        item.get("ok") for item in (axe, basic, contrast)
                    ),
                }
            template_data_valid = bool(calm) and all(
                _valid_calm_result(result) for result in calm.values()
            )
            items = {}
            for index in range(1, 14):
                name = f"K{index}"
                template_items = {
                    template_id: result.get("items", {}).get(name, {})
                    for template_id, result in calm.items()
                }
                reasons = [
                    f"{template_id}: {reason}"
                    for template_id, item in template_items.items()
                    for reason in item.get("reasons", [])
                ]
                passed = template_data_valid and all(
                    item.get("pass") is True for item in template_items.values()
                )
                if name == "K7" and lint.get("ok") is not True:
                    passed = False
                    reasons.append(
                        f"K7 calm lint failed with {len(lint.get('findings', []))} findings"
                    )
                if name == "K13":
                    keyboard_passed = (
                        c12_raw.get("ok") is True
                        and c12_raw.get("measurement_valid") is True
                    )
                    accessibility_passed = c13_raw.get("pass") is True
                    if not keyboard_passed:
                        reasons.append("K13 requires passing C12 keyboard evidence")
                    if not accessibility_passed:
                        reasons.append("K13 requires passing C13 accessibility evidence")
                    passed = passed and keyboard_passed and accessibility_passed
                items[name] = {
                    "pass": passed,
                    "reasons": reasons,
                    "templates": template_items,
                }
            passed_items = sum(item["pass"] for item in items.values())
            passed = template_data_valid and passed_items == 13
            raw = {
                "pass": passed,
                "measurement_valid": template_data_valid,
                "items": items,
                "templates": calm,
                "lint": lint,
                "C12": c12_raw,
                "C13": c13_raw,
            }
            criteria[criterion] = _entry(
                "pass" if passed else "fail",
                f"{passed_items}/13 K-items",
                raw,
                criterion,
            )

    if args.shots:
        shots = browser_json(
            ["node", str(ROOT / "tools" / "visual.mjs"), "--shots", str(args.out / "shots")],
            timeout=300,
        )
    else:
        shots = None
    if network_raw is not None:
        netlog_findings, netlog_count = _netlog_findings(
            netlog_dir,
            browser_runs,
            selected_port,
        )
        raw = criteria["C14"]["raw"]
        combined = list(raw.get("findings", [])) + netlog_findings
        findings = []
        seen = set()
        for finding in combined:
            key = json.dumps(finding, sort_keys=True, ensure_ascii=False)
            if key not in seen:
                findings.append(finding)
                seen.add(key)
        raw = {
            **raw,
            "findings": findings,
            "netlog_directory": str(netlog_dir),
            "netlog_files": netlog_count,
            "browser_runs": browser_runs,
            "ok": raw.get("ok") is True and not findings,
        }
        criteria["C14"] = _entry(
            "pass" if raw["ok"] else "fail",
            f"{len(findings)} findings",
            raw,
            "C14",
        )
    usability = {"status": "skipped (--automated-only)", "points": 0.0, "file": None, "raw": None} if args.automated_only else _usability()
    totals = score_totals(criteria, usability["points"])
    return {"criteria": criteria, "usability": usability, "totals": totals, "shots": shots}


def _print_table(score):
    print(f"{'Criterion':<10} {'Measured value':<48} {'Target':<39} {'Result':<9} {'Points':>6}")
    print("-" * 118)
    for name, item in score["criteria"].items():
        value = str(item["value"]).replace("\n", " ")[:48]
        target = item["target"][:39]
        points = f"{item['points']:.1f}/{item['max_points']:.1f}" if item["max_points"] else "gate"
        print(f"{name:<10} {value:<48} {target:<39} {item['status']:<9} {points:>6}")
    usability = score["usability"]
    print(f"{'Usability':<10} {usability['status']:<48} {'Human review: six x 0.5':<39} {'pending' if usability['file'] is None else usability['status']:<9} {usability['points']:.1f}/3.0")
    totals = score["totals"]
    suffix = f" (failed gates: {', '.join(totals['failed_gates'])})" if totals["failed_gates"] else ""
    if totals["pending_gates"]:
        suffix += f" (not run: {', '.join(totals['pending_gates'])})"
    print(f"TOTAL {totals['total']:.1f}/10.0 - automated {totals['automated']:.1f}/7.0{suffix}")


def _redact_clipboard_snapshots(value):
    if isinstance(value, list):
        return [_redact_clipboard_snapshots(item) for item in value]
    if not isinstance(value, dict):
        return value
    output = {}
    for key, item in value.items():
        if key == "clipboard_snapshot" and isinstance(item, dict):
            allowed = {
                "available", "ok", "error", "skipped", "length", "sha256",
            }
            output[key] = {
                field: _redact_clipboard_snapshots(field_value)
                for field, field_value in item.items()
                if field in allowed
            }
        else:
            output[key] = _redact_clipboard_snapshots(item)
    return output


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--automated-only", action="store_true")
    parser.add_argument("--only")
    parser.add_argument("--no-windows", action="store_true")
    parser.add_argument("--live", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--port", type=int)
    parser.add_argument("--shots", action="store_true")
    parser.add_argument("--out", type=Path, default=ROOT / "docs" / "scores")
    args = parser.parse_args(argv)
    if args.live:
        parser.error(LIVE_WINDOW_UNAVAILABLE)
    try:
        score = run_score(args)
    except ValueError as error:
        parser.error(str(error))
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M")
    output_dir = args.out
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"{stamp}.json"
    document = _redact_clipboard_snapshots({
        "generated": datetime.now().astimezone().isoformat(timespec="seconds"),
        "flags": {
            key: str(value) if isinstance(value, Path) else value
            for key, value in vars(args).items()
        },
        **score,
    })
    path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _print_table(score)
    try:
        display_path = path.relative_to(ROOT)
    except ValueError:
        display_path = path
    print(f"Score file: {display_path}")
    failed = any(item["status"] == "fail" for item in score["criteria"].values())
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
