import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

import pytest

import core.cli as cli_module
from conftest import ROOT, free_port

P6_RUNNER = ROOT / "tools" / "e2e.mjs"
P6_SKIP_REASON = "tools/e2e.mjs backend is unavailable"


def cli(env, port, *args, input_text=None):
    return subprocess.run(
        [sys.executable, str(ROOT / "report_shell.py"), "--port", str(port), *args],
        cwd=ROOT,
        env=env,
        input=input_text,
        capture_output=True,
        text=True,
        timeout=10,
    )


def test_isolated_cli_http_timeout_is_configurable(monkeypatch):
    seen = []

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def read(self):
            return b'{"ok":true}'

    monkeypatch.setenv("RS_CLI_HTTP_TIMEOUT", "12")
    monkeypatch.setattr(
        cli_module.urllib.request,
        "urlopen",
        lambda request, timeout: seen.append(timeout) or Response(),
    )

    assert cli_module._request(18920, "/test", body={"value": 1}) == {"ok": True}
    assert seen == [12.0]


def test_list_check_and_new_round_trip(tmp_path):
    env = dict(os.environ, RS_DATA_DIR=str(tmp_path / "data"))
    port = free_port()
    listed = cli(env, port, "list")
    assert listed.returncode == 0
    assert any(item["id"] == "_starter" for item in json.loads(listed.stdout))

    repo = tmp_path / "repo"
    import shutil

    shutil.copytree(ROOT, repo, ignore=shutil.ignore_patterns(".git", "__pycache__"))
    created = subprocess.run(
        [sys.executable, str(repo / "report_shell.py"), "new", "acme/sample"],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
    )
    assert created.returncode == 0
    assert (repo / "templates" / "acme" / "sample" / "template.json").exists()


@pytest.mark.skipif(not P6_RUNNER.is_file(), reason=P6_SKIP_REASON)
def test_starter_check_succeeds_with_p6_expectation_backend(tmp_path):
    env = dict(os.environ, RS_DATA_DIR=str(tmp_path / "data"))
    checked = cli(env, free_port(), "check", "_starter")
    assert checked.returncode == 0, checked.stderr


def test_starter_and_new_template_carry_canonical_expectation(tmp_path):
    canonical = (
        ROOT
        / "templates"
        / "global"
        / "_starter"
        / "fixtures"
        / "expect"
        / "golden.json"
    )
    assert canonical.is_file()
    expected = json.loads(canonical.read_text(encoding="utf-8"))
    assert expected["copies"]["starter-copy"]

    repo = tmp_path / "repo"
    import shutil

    shutil.copytree(ROOT, repo, ignore=shutil.ignore_patterns(".git", "__pycache__"))
    created = subprocess.run(
        [sys.executable, str(repo / "report_shell.py"), "new", "example/sample"],
        cwd=repo,
        capture_output=True,
        text=True,
    )
    assert created.returncode == 0, created.stderr
    copied = (
        repo
        / "templates"
        / "example"
        / "sample"
        / "fixtures"
        / "expect"
        / "golden.json"
    )
    assert json.loads(copied.read_text(encoding="utf-8")) == expected


@pytest.mark.skipif(not P6_RUNNER.is_file(), reason=P6_SKIP_REASON)
def test_read_only_template_commands_do_not_create_data_dir(tmp_path):
    data_dir = tmp_path / "must-not-exist"
    env = dict(os.environ, RS_DATA_DIR=str(data_dir))
    port = free_port()
    assert cli(env, port, "list").returncode == 0
    checked = cli(env, port, "check", "_starter")
    assert checked.returncode == 0, checked.stderr
    assert not data_dir.exists()


def test_global_template_wraps_bare_data_with_neutral_agent_bot(tmp_path):
    data_dir = tmp_path / "data"
    env = dict(os.environ, RS_DATA_DIR=str(data_dir))
    port = free_port()
    payload = tmp_path / "bare.json"
    payload.write_text('{"message":"Neutral payload"}', encoding="utf-8")
    try:
        shown = cli(
            env,
            port,
            "show",
            "_starter",
            "--data",
            str(payload),
            "--no-window",
        )
        assert shown.returncode == 0, shown.stderr
        run_id = json.loads(shown.stdout)["run_id"]
        record = json.loads(
            (data_dir / "runs" / f"{run_id}.json").read_text(encoding="utf-8")
        )
        assert record["payload"]["bot"] == "agent"
    finally:
        cli(env, port, "stop")


def test_show_submit_wait_result_cancel_status_and_stop(tmp_path):
    data_dir = tmp_path / "data"
    env = dict(os.environ, RS_DATA_DIR=str(data_dir))
    port = free_port()
    fixture = ROOT / "templates" / "global" / "_starter" / "fixtures" / "golden.json"
    try:
        shown = cli(env, port, "show", "_starter", "--data", str(fixture), "--no-window")
        assert shown.returncode == 0, shown.stderr
        run = json.loads(shown.stdout)
        status = json.loads(cli(env, port, "status").stdout)
        assert status["up"] is True and status["open_runs"] == 1
        hello = json.loads(
            urllib.request.urlopen(f"http://127.0.0.1:{port}/hello").read()
        )
        assert hello["runner"] == "grokbot-desk/1"

        page = urllib.request.urlopen(f"http://127.0.0.1:{port}/").read().decode()
        boot = json.loads(re.search(r'<script id="rs-boot" type="application/json">(.*?)</script>', page, re.S).group(1))
        body = json.dumps({"run_id": run["run_id"], "data": {"choice": "erledigt", "note": ""}}).encode()
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/submit",
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Origin": f"http://127.0.0.1:{port}",
                "X-RS-CSRF": boot["csrf"],
            },
        )
        assert json.loads(urllib.request.urlopen(request).read())["ok"]
        assert cli(env, port, "wait", run["run_id"], "--timeout", "2").returncode == 0
        result = cli(env, port, "result", run["run_id"])
        assert json.loads(result.stdout)["status"] == "submitted"

        second = json.loads(cli(env, port, "show", "_starter", "--data", str(fixture), "--no-window").stdout)
        assert cli(env, port, "cancel", second["run_id"]).returncode == 0
        assert json.loads(cli(env, port, "result", second["run_id"]).stdout)["status"] == "cancelled"
    finally:
        cli(env, port, "stop")


def test_cli_exit_codes(tmp_path):
    env = dict(os.environ, RS_DATA_DIR=str(tmp_path / "data"))
    port = free_port()
    bad = tmp_path / "bad.json"
    bad.write_text('{"message": 3}', encoding="utf-8")
    assert cli(env, port, "show", "_starter", "--data", str(bad), "--no-window").returncode == 2
    assert cli(env, port, "result", "missing").returncode == 6
    assert cli(env, port, "wait", "missing", "--timeout", ".1").returncode == 6


def test_duplicate_run_id_is_invalid_payload(tmp_path):
    data_dir = tmp_path / "data"
    env = dict(os.environ, RS_DATA_DIR=str(data_dir))
    port = free_port()
    payload = tmp_path / "payload.json"
    payload.write_text(
        json.dumps(
            {
                "schema": "report-shell/payload@1",
                "template": "_starter",
                "version": 1,
                "run_id": "20261008-120000-test-abcd",
                "bot": "example-dev-bot",
                "title": "Duplicate test",
                "created": "2026-10-08T12:00:00+02:00",
                "data": {"message": "Hello"},
            }
        ),
        encoding="utf-8",
    )
    try:
        assert cli(env, port, "show", "_starter", "--data", str(payload), "--no-window").returncode == 0
        assert cli(env, port, "show", "_starter", "--data", str(payload), "--no-window").returncode == 2
    finally:
        cli(env, port, "stop")


def test_port_override_is_accepted_after_command(tmp_path):
    env = dict(os.environ, RS_DATA_DIR=str(tmp_path / "data"))
    port = free_port()
    result = subprocess.run(
        [sys.executable, str(ROOT / "report_shell.py"), "status", "--port", str(port)],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    assert json.loads(result.stdout)["port"] == port


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("run_id", ""),
        ("run_id", None),
        ("run_id", False),
        ("created", None),
        ("created", "9999-12-31T23:00:00+00:00"),
        ("notify", None),
        ("template", []),
    ],
)
def test_show_malformed_envelope_fields_exit_2_without_traceback(
    tmp_path, field, value
):
    env = dict(os.environ, RS_DATA_DIR=str(tmp_path / "data"))
    port = free_port()
    payload = {
        "schema": "report-shell/payload@1",
        "template": "_starter",
        "version": 1,
        "bot": "example-dev-bot",
        "title": "Malformed envelope",
        "created": "2026-10-08T12:00:00+02:00",
        "data": {"message": "Hello"},
    }
    payload[field] = value
    source = tmp_path / "payload.json"
    source.write_text(json.dumps(payload), encoding="utf-8")
    try:
        result = cli(env, port, "show", "_starter", "--data", str(source), "--no-window")
        assert result.returncode == 2
        assert "Traceback" not in result.stderr
    finally:
        cli(env, port, "stop")


def test_finding_8_cli_rejects_non_json_numeric_constants(tmp_path):
    env = dict(os.environ, RS_DATA_DIR=str(tmp_path / "data"))
    port = free_port()
    source = tmp_path / "payload.json"
    source.write_text(
        """
        {
          "schema":"report-shell/payload@1",
          "template":"_starter",
          "version":1,
          "bot":"example-dev-bot",
          "title":"Non-finite",
          "created":"2026-10-08T12:00:00+02:00",
          "expires_minutes":NaN,
          "data":{"message":"Hello"}
        }
        """,
        encoding="utf-8",
    )
    result = cli(env, port, "show", "_starter", "--data", str(source), "--no-window")
    assert result.returncode == 2
    assert "invalid JSON" in result.stderr
    assert "Traceback" not in result.stderr


def test_finding_5_cli_rejects_deep_payload_and_config_without_traceback(
    tmp_path
):
    data_dir = tmp_path / "data"
    env = dict(os.environ, RS_DATA_DIR=str(data_dir))
    port = free_port()
    source = tmp_path / "deep.json"
    source.write_text(
        "[" * 1100 + "0" + "]" * 1100,
        encoding="utf-8",
    )
    payload_result = cli(
        env, port, "show", "_starter", "--data", str(source), "--no-window"
    )
    assert payload_result.returncode == 2
    assert "nesting" in payload_result.stderr
    assert "Traceback" not in payload_result.stderr

    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "config.json").write_text(
        "[" * 65 + "0" + "]" * 65,
        encoding="utf-8",
    )
    config_result = cli(env, port, "status")
    assert config_result.returncode == 2
    assert "nesting" in config_result.stderr
    assert "Traceback" not in config_result.stderr


@pytest.mark.parametrize(
    "name",
    [
        "../escaped-template",
        "./sample",
        "acme/..",
        "bad namespace/sample",
        "acme/bad name",
        "C:/drive-template",
    ],
)
def test_new_rejects_invalid_or_traversing_identifiers(tmp_path, name):
    repo = tmp_path / "repo"
    import shutil

    shutil.copytree(ROOT, repo, ignore=shutil.ignore_patterns(".git", "__pycache__"))
    result = subprocess.run(
        [sys.executable, str(repo / "report_shell.py"), "new", name],
        cwd=repo,
        env=dict(os.environ, RS_DATA_DIR=str(tmp_path / "data")),
        capture_output=True,
        text=True,
    )
    assert result.returncode == 7
    assert not (repo / "escaped-template").exists()


def test_new_rejects_existing_target(tmp_path):
    repo = tmp_path / "repo"
    import shutil

    shutil.copytree(ROOT, repo, ignore=shutil.ignore_patterns(".git", "__pycache__"))
    first = subprocess.run(
        [sys.executable, str(repo / "report_shell.py"), "new", "acme/sample"],
        cwd=repo,
        capture_output=True,
        text=True,
    )
    second = subprocess.run(
        [sys.executable, str(repo / "report_shell.py"), "new", "acme/sample"],
        cwd=repo,
        capture_output=True,
        text=True,
    )
    assert first.returncode == 0
    assert second.returncode == 7


def test_cli_output_is_ascii_under_cp1252_and_preserves_unicode_json(tmp_path):
    data_dir = tmp_path / "data"
    results = data_dir / "results"
    results.mkdir(parents=True)
    run_id = "20261008-120000-unicode-abcd"
    expected = {
        "schema": "report-shell/result@1",
        "run_id": run_id,
        "text": "Emoji 😀, umlauts äöü, CJK 漢字",
    }
    (results / f"{run_id}.json").write_text(
        json.dumps(expected, ensure_ascii=False),
        encoding="utf-8",
    )
    env = dict(
        os.environ,
        RS_DATA_DIR=str(data_dir),
        PYTHONIOENCODING="cp1252",
    )
    result = subprocess.run(
        [sys.executable, str(ROOT / "report_shell.py"), "result", run_id],
        cwd=ROOT,
        env=env,
        capture_output=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.isascii()
    assert json.loads(result.stdout) == expected

    missing = subprocess.run(
        [
            sys.executable,
            str(ROOT / "report_shell.py"),
            "show",
            "_starter",
            "--data",
            str(tmp_path / "missing-😀-漢字.json"),
            "--no-window",
        ],
        cwd=ROOT,
        env=env,
        capture_output=True,
        timeout=10,
    )
    assert missing.returncode == 2
    assert missing.stderr.isascii()
    assert b"Traceback" not in missing.stderr


def test_show_accepts_one_utf8_bom_from_file_and_stdin(tmp_path):
    data_dir = tmp_path / "data"
    env = dict(os.environ, RS_DATA_DIR=str(data_dir))
    port = free_port()
    raw = b"\xef\xbb\xbf" + json.dumps({"message": "BOM payload"}).encode("utf-8")
    source = tmp_path / "powershell-utf8.json"
    source.write_bytes(raw)
    command = [
        sys.executable,
        str(ROOT / "report_shell.py"),
        "--port",
        str(port),
        "show",
        "_starter",
        "--data",
    ]
    try:
        from_file = subprocess.run(
            [*command, str(source), "--no-window"],
            cwd=ROOT,
            env=env,
            capture_output=True,
            timeout=10,
        )
        assert from_file.returncode == 0, from_file.stderr
        assert json.loads(from_file.stdout)["run_id"]

        from_stdin = subprocess.run(
            [*command, "-", "--no-window"],
            cwd=ROOT,
            env=env,
            input=raw,
            capture_output=True,
            timeout=10,
        )
        assert from_stdin.returncode == 0, from_stdin.stderr
        assert json.loads(from_stdin.stdout)["run_id"]
    finally:
        cli(env, port, "stop")
