import argparse
import json
import re

import pytest

from tools import score
from tools.score import calculate_points, score_totals


def _complete_calm_result():
    scenes = []
    for fixture in ("golden", "edge-max"):
        for theme in ("light", "dark"):
            for width, height in ((1500, 1000), (1280, 720)):
                for open_runs in (1, 3):
                    raw = {
                        "K1": {
                            "primary_ids": ["#primary"],
                            "accent_fill_ids": ["#primary"],
                            "disabled_primary": None,
                        },
                        "K2": {"items": []},
                        "K3": {
                            "open_runs": open_runs,
                            "rail_rendered": open_runs == 3,
                            "rail_width": 180 if open_runs == 3 else 0,
                            "focusable_descendants": 1 if open_runs == 3 else 0,
                        },
                        "K4": {"font_sizes": [16, 24], "font_weights": ["400", "600"]},
                        "K5": {"boxes": [], "max_box_ancestors": 0},
                        "K6": {"accent_hue": 210.0, "off_accent": []},
                        "K7": {
                            "item_gaps": [20],
                            "wide_text": [],
                            "page_background": [245, 245, 240],
                            "background_ratio": (
                                0.8 if fixture == "golden" and (width, height) == (1500, 1000)
                                else None
                            ),
                            "lint_pass": None,
                        },
                        "K8": {"visible_inputs": [], "open_secondary": []},
                        "K9": {
                            "measured": fixture == "golden" and (width, height) == (1280, 720),
                            "visible_interactive_above_fold": 5,
                        },
                        "K10": {"mockups": [], "tablists": [], "interaction": None},
                        "K11": {
                            "noise": [],
                            "header_titles": 1,
                            "header_controls": [],
                        },
                        "K12": {
                            "normal": {
                                "reduced_motion": False,
                                "motion": [],
                                "max_ms": 0,
                                "attention": [],
                            },
                            "reduced": {
                                "reduced_motion": True,
                                "motion": [],
                                "max_ms": 0,
                                "attention": [],
                            },
                        },
                        "K13": {
                            "copy_focus": {"pass": True, "controls": []},
                            "keyboard": {"pass": True, "error": None},
                            "accessibility": {
                                "pass": True,
                                "unnamed": 0,
                                "positive_tabindex": 0,
                                "violations": [],
                            },
                            "dependency": "C16 requires C12 and C13 evidence",
                        },
                    }
                    scene_items = {
                        name: {"pass": True, "reasons": [], "raw": value}
                        for name, value in raw.items()
                    }
                    scenes.append({
                        "template": "_starter",
                        "fixture": fixture,
                        "theme": theme,
                        "viewport": {"width": width, "height": height},
                        "open_runs": open_runs,
                        "items": scene_items,
                        "ok": True,
                    })
    return {
        "mode": "calm",
        "template": "_starter",
        "ok": True,
        "passed": 13,
        "total": 13,
        "items": {
            f"K{index}": {
                "pass": True,
                "reasons": [],
                "raw": [
                    {
                        "template": scene["template"],
                        "fixture": scene["fixture"],
                        "theme": scene["theme"],
                        "viewport": scene["viewport"],
                        "open_runs": scene["open_runs"],
                        **scene["items"][f"K{index}"]["raw"],
                    }
                    for scene in scenes
                ],
            }
            for index in range(1, 14)
        },
        "scenes": scenes,
        "coverage": {
            "expected": 2,
            "executed": 2,
            "templates": [{"template": "_starter", "expected": 2, "executed": 2}],
        },
        "_process": {"returncode": 0, "stderr": ""},
    }


def test_score_table_targets_are_printable_on_default_windows_console():
    for target in score.TARGETS.values():
        target.encode("cp1252")


def test_partial_credit_rules():
    assert calculate_points("C1", {"cold_pass": True, "warm_pass": False}) == 0.5
    assert calculate_points("C6", {"ratio": 0.97, "total": 30}) == 0.5
    assert calculate_points("C7", {"light_pass": True, "dark_pass": False}) == 0.5


def test_hard_gate_failure_caps_total_at_five():
    criteria = {
        "C1": {"status": "pass", "points": 1.0},
        "C4": {"status": "pass", "points": 1.0},
        "C6": {"status": "pass", "points": 1.0},
        "C7": {"status": "pass", "points": 1.0},
        "C9": {"status": "pass", "points": 1.0},
        "C10": {"status": "pass", "points": 0.5},
        "C12": {"status": "pass", "points": 1.0},
        "C13": {"status": "pass", "points": 0.5},
        "C2": {"status": "pass", "points": 0},
        "C3": {"status": "pass", "points": 0},
        "C5": {"status": "fail", "points": 0},
        "C8": {"status": "pass", "points": 0},
        "C11": {"status": "pass", "points": 0},
        "C14": {"status": "pass", "points": 0},
        "C15": {"status": "pass", "points": 0},
    }

    totals = score_totals(criteria, usability_points=3.0)

    assert totals["automated"] == 7.0
    assert totals["uncapped"] == 10.0
    assert totals["total"] == 5.0
    assert totals["failed_gates"] == ["C5"]


def test_c16_is_a_hard_gate_with_the_required_table_label(capsys):
    assert "C16" in score.HARD_GATES
    assert score.TARGETS["C16"] == "calm: 13 K-items on every scene"
    criteria = {
        name: {
            "status": "pass",
            "value": "pass",
            "target": score.TARGETS[name],
            "points": 0.0,
            "max_points": score.POINTS.get(name, 0.0),
        }
        for name in score.TARGETS
    }
    criteria["C16"]["status"] = "fail"
    totals = score_totals(criteria, usability_points=6.0)
    assert totals["total"] == 5.0
    assert totals["failed_gates"] == ["C16"]

    score._print_table({
        "criteria": criteria,
        "usability": {"status": "pending", "points": 0.0, "file": None},
        "totals": totals,
    })
    assert "C16" in capsys.readouterr().out


def test_c16_runs_calm_per_template_lint_and_requires_c12_c13_evidence(
    tmp_path, monkeypatch
):
    commands = []
    monkeypatch.setattr(score, "_registered_templates", lambda: ["_starter", "synthetic-template"])

    def command_json(command, timeout=300):
        commands.append(command)
        if any(str(part).endswith("lint_src.py") for part in command):
            return {"ok": True, "findings": []}
        if command[0] == "node" and "calm" in command:
            return _complete_calm_result()
        if command[0] == "node" and "keyboard" in command:
            return {"ok": True, "passed": 2, "total": 2, "cases": [{}, {}]}
        if command[0] == "node" and ("axe" in command or "a11y-basic" in command):
            return {"ok": True}
        if str(command[-1]).endswith("contrast.py"):
            return {"ok": True}
        raise AssertionError(command)

    monkeypatch.setattr(score, "_command_json", command_json)
    result = score.run_score(_args(tmp_path, "C16", no_windows=True))

    c16 = result["criteria"]["C16"]
    assert c16["status"] == "pass"
    assert set(c16["raw"]["items"]) == {f"K{index}" for index in range(1, 14)}
    assert [command[-1] for command in commands if "calm" in command] == [
        "_starter",
        "synthetic-template",
    ]
    assert any(command[-1:] == ["--calm"] for command in commands)


def test_review_finding_13_c16_rejects_failed_or_incomplete_calm_output(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(score, "_registered_templates", lambda: ["_starter"])

    def command_json(command, timeout=300):
        if any(str(part).endswith("lint_src.py") for part in command):
            return {"ok": True, "findings": []}
        if command[0] == "node" and "calm" in command:
            return {
                "ok": False,
                "passed": 13,
                "total": 13,
                "items": {
                    f"K{index}": {"pass": True, "reasons": [], "raw": []}
                    for index in range(1, 14)
                },
                "scenes": [],
                "coverage": {},
                "_process": {"returncode": 1, "stderr": "measurement failed"},
            }
        if command[0] == "node" and "keyboard" in command:
            return {
                "ok": True,
                "passed": 1,
                "total": 1,
                "cases": [{}],
                "coverage": {"expected": 1, "executed": 1},
            }
        if command[0] == "node":
            return {"ok": True}
        if str(command[-1]).endswith("contrast.py"):
            return {"ok": True}
        raise AssertionError(command)

    monkeypatch.setattr(score, "_command_json", command_json)

    result = score.run_score(_args(tmp_path, "C16", no_windows=True))

    assert result["criteria"]["C16"]["status"] == "fail"
    assert result["criteria"]["C16"]["raw"]["measurement_valid"] is False


def test_round_2_finding_14_c16_requires_raw_schema_for_every_k_item():
    complete = _complete_calm_result()
    assert score._valid_calm_result(complete) is True

    for name in (f"K{index}" for index in range(1, 14)):
        incomplete = json.loads(json.dumps(complete))
        incomplete["scenes"][0]["items"][name]["raw"] = None
        assert score._valid_calm_result(incomplete) is False, name

    mismatched = json.loads(json.dumps(complete))
    mismatched["items"]["K1"]["raw"][0]["primary_ids"] = ["#different"]
    assert score._valid_calm_result(mismatched) is False

    malformed = json.loads(json.dumps(complete))
    malformed["scenes"][0]["items"]["K13"]["raw"]["copy_focus"]["controls"] = [{}]
    assert score._valid_calm_result(malformed) is False


def test_review_finding_16_dev_helpers_use_portable_runtime_resolution():
    server = (score.ROOT / "tools" / "dev" / "rs-server.mjs").read_text(encoding="utf-8")
    preview = (score.ROOT / "tools" / "dev" / "kit-preview.mjs").read_text(encoding="utf-8")
    shell_shots = (score.ROOT / "tools" / "dev" / "shell-shots.mjs").read_text(
        encoding="utf-8"
    )

    combined = server + preview + shell_shots
    assert "RS_PLAYWRIGHT_CORE" in combined
    assert "browserChannel" in combined
    assert "measurement.json" in server + shell_shots


def test_review_finding_17_generated_score_output_is_not_committed():
    score_files = list((score.ROOT / "docs" / "scores").glob("*.json"))
    assert all(re.fullmatch(r"usability-\d{4}-\d{2}-\d{2}\.json", item.name) for item in score_files)


def test_review_finding_18_public_measurement_wording_is_browser_neutral():
    sources = [score.ROOT / "tools" / "score.py"]
    text = "\n".join(path.read_text(encoding="utf-8") for path in sources)

    assert re.search(r"\bBrave\b", text) is None


def test_round_2_finding_21_all_preview_display_identities_are_fictional():
    text = (score.ROOT / "tools" / "dev" / "kit-preview.html").read_text(
        encoding="utf-8"
    )

    assert "@northwind" in text


def test_not_run_gate_does_not_silently_pass_or_apply_failure_cap():
    criteria = {
        "C2": {"status": "not run", "points": 0},
        "C3": {"status": "pass", "points": 0},
        "C5": {"status": "pass", "points": 0},
        "C8": {"status": "pass", "points": 0},
        "C11": {"status": "pass", "points": 0},
        "C14": {"status": "pass", "points": 0},
        "C15": {"status": "pass", "points": 0},
    }

    totals = score_totals(criteria, usability_points=0)

    assert totals["failed_gates"] == []
    assert totals["pending_gates"] == ["C2"]


def _args(tmp_path, only, *, no_windows):
    return argparse.Namespace(
        only=only,
        no_windows=no_windows,
        port=18920,
        automated_only=True,
        shots=False,
        out=tmp_path,
    )


def test_live_window_criteria_are_not_part_of_this_distribution(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(
        score,
        "_command_json",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("must not run a tool")),
    )

    result = score.run_score(_args(tmp_path, "C1,C2,C3,C4", no_windows=False))

    for criterion in ("C1", "C2", "C3", "C4"):
        assert result["criteria"][criterion]["status"] == "not run"
        assert (
            result["criteria"][criterion]["value"]
            == "live window measurements are not part of this distribution"
        )


def test_live_option_reports_distribution_limit(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(
        score,
        "run_score",
        lambda args: {
            "criteria": {},
            "usability": {"points": 0.0, "file": None},
            "totals": {"failed_gates": [], "pending_gates": []},
            "shots": None,
        },
    )
    monkeypatch.setattr(score, "_print_table", lambda result: None)

    with pytest.raises(SystemExit):
        score.main(["--live", "--out", str(tmp_path)])

    assert (
        "live window measurements are not part of this distribution"
        in capsys.readouterr().err
    )


def test_finding_5_incomplete_headless_measurements_cannot_pass_or_score(
    tmp_path, monkeypatch
):
    def command_json(command, timeout=300):
        executable = str(command[1] if command[0] == "node" else command[-1])
        if executable.endswith("measure_copy.py"):
            return {"ok": True, "passed": 20, "total": 20, "cases": []}
        if executable.endswith("counter_test.mjs"):
            return {"ok": True, "passed": 30, "total": 30, "ratio": 1, "cases": []}
        if executable.endswith("visual.mjs"):
            return {"ok": True, "results": []}
        if executable.endswith("e2e.mjs"):
            return {"ok": True, "passed": 1, "total": 1, "cases": []}
        raise AssertionError(command)

    monkeypatch.setattr(score, "_command_json", command_json)

    result = score.run_score(_args(tmp_path, "C5,C6,C7,C12", no_windows=False))

    for criterion in ("C5", "C6", "C7", "C12"):
        assert result["criteria"][criterion]["status"] == "fail"
        assert result["criteria"][criterion]["points"] == 0


def test_finding_out_directory_is_used_for_score_and_shots(tmp_path, monkeypatch):
    shot_commands = []
    args = _args(tmp_path, "C1", no_windows=True)
    args.shots = True
    monkeypatch.setattr(
        score,
        "_command_json",
        lambda command, timeout=300: shot_commands.append(command) or {"ok": True},
    )

    score.run_score(args)

    assert shot_commands == [
        ["node", str(score.ROOT / "tools" / "visual.mjs"), "--shots", str(tmp_path / "shots")]
    ]

    args.shots = False
    monkeypatch.setattr(score, "run_score", lambda parsed: {
        "criteria": {},
        "usability": {"status": "pending (manual review)", "points": 0.0, "file": None},
        "totals": {"automated": 0.0, "total": 0.0, "failed_gates": [], "pending_gates": []},
        "shots": None,
    })
    monkeypatch.setattr(score, "_print_table", lambda result: None)

    assert score.main(["--no-windows", "--out", str(tmp_path)]) == 0
    files = list(tmp_path.glob("*.json"))
    assert len(files) == 1


def test_round_2_finding_5_c14_checks_audit_only_netlogs_and_missing_logs(tmp_path):
    (tmp_path / "keyboard-audit.json").write_text(
        json.dumps({
            "mode": "keyboard",
            "requests": [
                "http://127.0.0.1:18929/",
                "https://audit.example.invalid/tracker.js",
            ],
            "responses": [
                {
                    "url": "http://127.0.0.1:18929/audit-response",
                    "status": 200,
                    "headers": {},
                    "synthetic": False,
                },
                {
                    "url": "http://127.0.0.1:18929/copy",
                    "status": 200,
                    "headers": {},
                    "synthetic": True,
                },
            ],
            "errors": [],
        }),
        encoding="utf-8",
    )

    findings, logs = score._netlog_findings(
        tmp_path,
        expected_runs=[
            {"command": ["node", "keyboard"], "logs": ["keyboard-audit.json"]},
            {"command": ["node", "axe"], "logs": []},
        ],
        port=18929,
    )

    assert logs == 1
    assert any(
        item["type"] == "external_request"
        and item["url"] == "https://audit.example.invalid/tracker.js"
        for item in findings
    )
    assert any(
        item["type"] == "missing_csp"
        and item["url"].endswith("/audit-response")
        for item in findings
    )
    assert not any(
        item["type"] == "missing_csp" and item["url"].endswith("/copy")
        for item in findings
    )
    assert any(item["type"] == "missing_network_log" for item in findings)


def test_round_4_finding_7_c5_c14_share_the_selected_alternate_port(
    tmp_path, monkeypatch
):
    port = 18928
    monkeypatch.setenv("RS_TOOL_PORT", str(port))
    args = _args(tmp_path, "C5,C14", no_windows=False)
    args.port = port

    def command_json(command, timeout=300):
        directory = score.Path(score.os.environ["RS_NETLOG_DIR"])
        url = f"http://127.0.0.1:{port}/copy"
        (directory / f"{len(list(directory.glob('*.json')))}.json").write_text(
            json.dumps({
                "requests": [url],
                "responses": [{
                    "url": url,
                    "status": 200,
                    "headers": {"content-security-policy": "default-src 'self'"},
                    "synthetic": False,
                }],
            }),
            encoding="utf-8",
        )
        if str(command[-1]).endswith("measure_copy.py"):
            return {
                "ok": True,
                "passed": 20,
                "total": 20,
                "cases": [{"pass": True} for _ in range(20)],
                "network": {
                    "requests": [url],
                    "responses": [{
                        "url": url,
                        "status": 200,
                        "headers": {"content-security-policy": "default-src 'self'"},
                        "synthetic": False,
                    }],
                },
            }
        return {"ok": True, "findings": []}

    monkeypatch.setattr(score, "_command_json", command_json)

    result = score.run_score(args)

    assert result["criteria"]["C5"]["status"] == "pass"
    assert result["criteria"]["C14"]["status"] == "pass"
    assert result["criteria"]["C14"]["raw"]["findings"] == []
    assert score._allowed_browser_url("https://external.invalid/", port) is False


def test_round_2_finding_7_score_json_redacts_prior_clipboard_text(
    tmp_path, monkeypatch
):
    sentinel = "SCRATCH-PRIVATE-CLIPBOARD"
    monkeypatch.setattr(score, "run_score", lambda parsed: {
        "criteria": {
            "C5": {
                "status": "pass",
                "raw": {
                    "clipboard_snapshot": {
                        "ok": True,
                        "available": True,
                        "text": sentinel,
                        "length": len(sentinel),
                        "sha256": "a" * 64,
                    },
                },
            },
        },
        "usability": {"status": "pending", "points": 0.0, "file": None},
        "totals": {
            "automated": 0.0,
            "total": 0.0,
            "failed_gates": [],
            "pending_gates": [],
        },
        "shots": None,
    })
    monkeypatch.setattr(score, "_print_table", lambda result: None)

    assert score.main(["--no-windows", "--out", str(tmp_path)]) == 0
    saved = next(tmp_path.glob("*.json")).read_text(encoding="utf-8")
    assert sentinel not in saved
    snapshot = json.loads(saved)["criteria"]["C5"]["raw"]["clipboard_snapshot"]
    assert "text" not in snapshot
    assert snapshot["length"] == len(sentinel)


def test_round_2_finding_8_no_windows_never_runs_c5_clipboard_tool(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(
        score,
        "_command_json",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("must not run clipboard measurement")
        ),
    )

    result = score.run_score(_args(tmp_path, "C5", no_windows=True))

    assert result["criteria"]["C5"]["status"] == "not run"
    assert "clipboard" in result["criteria"]["C5"]["value"]


def test_round_3_finding_2_c15_requires_browser_result_time_measurement(
    tmp_path, monkeypatch
):
    commands = []

    def command_json(command, timeout=300):
        commands.append(command)
        if command[0] == "py":
            return {"ok": True}
        if command[0] == "node" and command[-2:] == ["strings", "--all"]:
            return {"ok": True}
        if command[0] == "node" and command[-1] == "time":
            return {"ok": False, "findings": [{"error": "wrong rendered time"}]}
        raise AssertionError(command)

    monkeypatch.setattr(score, "_command_json", command_json)
    monkeypatch.setattr(
        score,
        "_pytest",
        lambda file: {"ok": True, "returncode": 0, "output": "4 passed"},
    )

    result = score.run_score(_args(tmp_path, "C15", no_windows=True))

    assert result["criteria"]["C15"]["status"] == "fail"
    assert any(command[0] == "node" and command[-1] == "time" for command in commands)


def test_round_3_finding_5_score_uses_neutral_human_review_labels(
    tmp_path, monkeypatch, capsys
):
    scores = tmp_path / "docs" / "scores"
    scores.mkdir(parents=True)
    monkeypatch.setattr(score, "ROOT", tmp_path)

    assert score._usability()["status"] == "pending (manual review)"
    (scores / "usability-2026-10-08.json").write_text(
        json.dumps({f"U{index}": 0.5 for index in range(1, 7)}),
        encoding="utf-8",
    )
    usability = score._usability()
    assert usability["status"] == "human-reviewed"

    criteria = {
        name: {
            "status": "pass",
            "value": "pass",
            "target": score.TARGETS[name],
            "points": 0.0,
            "max_points": score.POINTS.get(name, 0.0),
        }
        for name in score.TARGETS
    }
    score._print_table({
        "criteria": criteria,
        "usability": usability,
        "totals": {
            "total": 3.0,
            "automated": 0.0,
            "failed_gates": [],
            "pending_gates": [],
        },
    })
    output = capsys.readouterr().out
    assert "Human review: six x 0.5" in output


def test_explicit_score_port_overrides_inherited_port_for_every_child(
    tmp_path, monkeypatch
):
    args = _args(tmp_path, "C8,C10", no_windows=True)
    args.port = 18921
    inherited = "18920"
    monkeypatch.setenv("RS_TOOL_PORT", inherited)
    child_ports = []

    def command_json(command, timeout=300):
        child_ports.append(score.os.environ.get("RS_TOOL_PORT"))
        return {"ok": False, "total": 0}

    def pytest_result(file):
        child_ports.append(score.os.environ.get("RS_TOOL_PORT"))
        return {"ok": True, "returncode": 0, "output": "pass"}

    monkeypatch.setattr(score, "_command_json", command_json)
    monkeypatch.setattr(score, "_pytest", pytest_result)

    score.run_score(args)

    assert child_ports
    assert set(child_ports) == {"18921"}
    assert score.os.environ["RS_TOOL_PORT"] == inherited
