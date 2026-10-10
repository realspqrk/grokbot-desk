"""Template contract checks."""
import json
import os
import subprocess
from pathlib import Path

from .jsonutil import loads
from .lint import lint_template
from .paths import data_dir as default_data_dir
from .registry import RegistryError, scan_registry
from .schema import SchemaError, check_schema, validate


def _read_json(path):
    try:
        return loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError(f"{path}: invalid JSON: {error}") from error


def _read_template_json(template, relative):
    try:
        return loads(template.read_text(relative))
    except (OSError, ValueError) as error:
        raise ValueError(
            f"{template.file_path(relative)}: invalid JSON: {error}"
        ) from error


def _expect_error(value, result_schema, counter_cases=False):
    if counter_cases:
        if not isinstance(value, list) or len(value) < 30:
            return "must be an array with at least 30 cases"
        required = {"name", "platform", "text", "count", "over"}
        for index, case in enumerate(value):
            if not isinstance(case, dict) or set(case) != required:
                return f"/{index}: must contain only name, platform, text, count, over"
            if not all(isinstance(case[key], str) for key in ("name", "platform", "text")):
                return f"/{index}: name, platform, and text must be strings"
            if type(case["count"]) is not int or case["count"] < 0:
                return f"/{index}/count: must be a non-negative integer"
            if type(case["over"]) is not bool:
                return f"/{index}/over: must be a boolean"
        return None
    if not isinstance(value, dict):
        return "must be an object"
    allowed = {"copies", "counters", "flow", "keyboard", "result"}
    unknown = set(value) - allowed
    if unknown:
        return f"unknown fields: {', '.join(sorted(unknown))}"
    copies = value.get("copies", {})
    if not isinstance(copies, dict) or not all(
        isinstance(key, str) and isinstance(item, str) for key, item in copies.items()
    ):
        return "/copies: must map strings to strings"
    counters = value.get("counters", {})
    if not isinstance(counters, dict):
        return "/counters: must be an object"
    for name, counter in counters.items():
        if not isinstance(name, str) or not isinstance(counter, dict):
            return "/counters: must map string ids to counter objects"
        if set(counter) != {"count", "limit", "over"}:
            return f"/counters/{name}: must contain only count, limit, over"
        if (
            type(counter["count"]) is not int
            or counter["count"] < 0
            or type(counter["limit"]) is not int
            or counter["limit"] < 0
            or type(counter["over"]) is not bool
        ):
            return f"/counters/{name}: invalid count, limit, or over"
    for field in ("flow", "keyboard"):
        steps = value.get(field, [])
        if not isinstance(steps, list):
            return f"/{field}: must be an array"
        allowed_steps = {"press", "repeat", "type"} if field == "keyboard" else {
            "click", "fill", "press", "repeat", "type",
        }
        for index, step in enumerate(steps):
            if not isinstance(step, dict):
                return f"/{field}/{index}: step must be an object"
            keys = set(step)
            if keys == {"repeat", "press"}:
                valid = (
                    "repeat" in allowed_steps
                    and type(step["repeat"]) is int
                    and step["repeat"] >= 1
                    and isinstance(step["press"], str)
                    and bool(step["press"])
                )
            elif len(keys) == 1 and next(iter(keys), None) in allowed_steps:
                kind = next(iter(keys))
                item = step[kind]
                valid = (
                    isinstance(item, str) and bool(item)
                    if kind != "fill"
                    else isinstance(item, list)
                    and len(item) == 2
                    and all(isinstance(part, str) for part in item)
                )
            else:
                valid = False
            if not valid:
                return f"/{field}/{index}: invalid {field} step"
    if "result" in value:
        try:
            validate(value["result"], result_schema, "/result")
        except SchemaError as error:
            return str(error)
    return None


def _tool_env(registry):
    if registry.user_templates_root is None:
        return None
    return dict(
        os.environ,
        RS_DATA_DIR=str(registry.user_templates_root.parent),
    )


def contract_findings(registry, repo_root, selected=None, run_expect_backend=False):
    root = Path(repo_root)
    findings = []
    selected = list(registry.values()) if selected is None else list(selected)
    strings_path = root / "core" / "i18n" / "de.json"
    if not strings_path.is_file():
        strings_path = Path(__file__).parent / "i18n" / "de.json"
    strings = _read_json(strings_path)
    tool_env = _tool_env(registry)
    for template in selected:
        try:
            data_schema = _read_template_json(template, "schema.json")
            result_schema = _read_template_json(template, "result.schema.json")
            check_schema(data_schema)
            check_schema(result_schema)
        except (ValueError, SchemaError) as error:
            findings.append(f"{template.id}: {error}")
            continue
        try:
            edges = template.glob_files("fixtures", "edge-*.json")
            invalid = template.glob_files("fixtures", "invalid-*.json")
        except RegistryError as error:
            findings.append(f"{template.id}: {error}")
            continue
        if len(edges) < 2:
            findings.append(f"{template.id}: at least two edge fixtures are required")
        if len(invalid) < 2:
            findings.append(f"{template.id}: at least two invalid fixtures are required")
        for relative in [Path("fixtures/golden.json"), *edges]:
            try:
                validate(_read_template_json(template, relative), data_schema)
            except (ValueError, SchemaError) as error:
                findings.append(f"{relative.name}: expected valid: {error}")
        for relative in invalid:
            try:
                validate(_read_template_json(template, relative), data_schema)
            except SchemaError:
                pass
            except ValueError as error:
                findings.append(str(error))
            else:
                findings.append(f"{relative.name}: expected invalid")
        try:
            findings.extend(
                f"{template.id}: {item}"
                for item in lint_template(template, strings)
            )
            expect_files = template.glob_files("fixtures/expect", "*.json")
        except RegistryError as error:
            findings.append(f"{template.id}: {error}")
            continue
        if expect_files:
            expect_valid = True
            for relative in expect_files:
                try:
                    value = _read_template_json(template, relative)
                except ValueError as error:
                    findings.append(str(error))
                    expect_valid = False
                    continue
                message = _expect_error(
                    value,
                    result_schema,
                    counter_cases=relative.name == "counter-cases.json",
                )
                if message:
                    findings.append(f"{relative.name}: {message}")
                    expect_valid = False
            if run_expect_backend:
                tool = root / "tools" / "e2e.mjs"
                if not tool.is_file():
                    findings.append(
                        f"{template.id}: tools/e2e.mjs is missing; expectations cannot be verified"
                    )
                elif expect_valid:
                    result = subprocess.run(
                        ["node", str(tool), "expect", template.id],
                        cwd=root,
                        capture_output=True,
                        text=True,
                        encoding="utf-8",
                        errors="replace",
                        env=tool_env,
                    )
                    if result.returncode:
                        findings.append(
                            result.stderr.strip()
                            or result.stdout.strip()
                            or f"expect check failed for {template.id}"
                        )
    return findings


def check_template_details(
    template_id, repo_root, data_dir_path=None, visual=False
):
    root = Path(repo_root)
    try:
        data_root = Path(data_dir_path or default_data_dir())
        registry = scan_registry(root / "templates", data_root / "templates")
    except RegistryError as error:
        return {"findings": [str(error)], "warnings": []}
    selected = list(registry.values()) if template_id == "--all" else [registry.get(template_id)]
    if selected == [None]:
        return {
            "findings": [f"unknown template: {template_id}"],
            "warnings": [],
        }
    findings = contract_findings(
        registry, root, selected=selected, run_expect_backend=True
    )
    tool_env = _tool_env(registry)
    if visual:
        tool = root / "tools" / "visual.mjs"
        if not tool.is_file():
            findings.append("tools/visual.mjs is missing; visual check cannot run")
        elif not findings:
            targets = list(registry) if template_id == "--all" else [template_id]
            for target in targets:
                result = subprocess.run(
                    ["node", str(tool), "--check", target],
                    cwd=root,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    env=tool_env,
                )
                if result.returncode:
                    findings.append(result.stderr.strip() or result.stdout.strip() or f"visual check failed for {target}")
    selected_ids = {template.id for template in selected}
    warnings = [
        warning
        for warning in registry.warnings
        if warning.split(":", 1)[0] in selected_ids
    ]
    return {"findings": findings, "warnings": warnings}


def check_template(
    template_id, repo_root, visual=False, data_dir_path=None
):
    return check_template_details(
        template_id,
        repo_root,
        data_dir_path=data_dir_path,
        visual=visual,
    )["findings"]
