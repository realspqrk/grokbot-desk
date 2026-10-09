import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

import pytest

import core.cli as cli_module
import conftest as fixture_module
from conftest import ROOT, free_port

P6_RUNNER = ROOT / "tools" / "e2e.mjs"
P6_SKIP_REASON = "tools/e2e.mjs backend is unavailable"


def _bounded_milliseconds(env, name, default):
    try:
        value = float(env.get(name, default))
    except (TypeError, ValueError):
        value = default
    if not value > 0:
        value = default
    return min(max(value, 1000), 120000)


def _check_timeout_seconds(env):
    inner_seconds = sum(
        _bounded_milliseconds(env, name, default) / 1000
        for name, default in (
            ("RS_SERVER_START_TIMEOUT_MS", 15000),
            ("RS_BROWSER_LAUNCH_TIMEOUT_MS", 30000),
            ("RS_E2E_NAVIGATION_TIMEOUT_MS", 30000),
            ("RS_E2E_READY_TIMEOUT_MS", 10000),
            ("RS_SHOW_PROCESS_TIMEOUT_MS", 30000),
        )
    )
    required = inner_seconds + 30 + 5
    try:
        configured = float(env.get("RS_TEST_CLI_TIMEOUT", required))
    except (TypeError, ValueError):
        configured = required
    if not configured > 0:
        configured = required
    return min(max(required, configured, 10), 660)


def _timeout_text(value):
    if value is None:
        return ""
    return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else str(value)


def cli(env, port, *args, input_text=None):
    run_env = dict(env)
    is_check = bool(args) and args[0] == "check"
    stage_path = None
    if is_check:
        run_env.setdefault("RS_E2E_DIAGNOSTICS", "1")
        stage_file = tempfile.NamedTemporaryFile(
            prefix="rs-e2e-stage-",
            suffix=".txt",
            delete=False,
        )
        stage_file.close()
        stage_path = Path(stage_file.name)
        run_env["RS_E2E_STAGE_FILE"] = str(stage_path)
    timeout = _check_timeout_seconds(run_env) if is_check else 10
    command = [
        sys.executable,
        str(ROOT / "report_shell.py"),
        "--port",
        str(port),
        *args,
    ]
    try:
        return subprocess.run(
            command,
            cwd=ROOT,
            env=run_env,
            input=input_text,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        stderr = _timeout_text(error.stderr)
        stdout = _timeout_text(error.stdout)
        try:
            stage_output = stage_path.read_text(encoding="utf-8") if stage_path else ""
        except OSError:
            stage_output = ""
        stages = re.findall(
            r"rs-e2e stage: ([^\r\n]+)",
            f"{stderr}\n{stage_output}",
        )
        stage = stages[-1] if stages else "no inner stage reported"
        detail = (
            f"CLI {' '.join(args)} timed out after {timeout:g} seconds; "
            f"last inner stage: {stage}"
        )
        if stdout:
            detail += f"\npartial stdout:\n{stdout}"
        if stderr:
            detail += f"\npartial stderr:\n{stderr}"
        raise AssertionError(detail) from None
    finally:
        if stage_path:
            stage_path.unlink(missing_ok=True)


@pytest.mark.parametrize(
    ("state_kind", "launch_attributed"),
    [
        ("missing", True),
        ("mismatched-pid", True),
        ("matching", False),
    ],
)
def test_teardown_never_touches_server_without_launch_ownership(
    tmp_path, monkeypatch, state_kind, launch_attributed
):
    port = 18920
    pid = 765432
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    owner = "test-launch-owner"
    env = {"RS_DATA_DIR": str(data_dir)}
    if launch_attributed:
        env["RS_MEASUREMENT_OWNER"] = owner
    if state_kind != "missing":
        state = {
            "pid": pid if state_kind == "matching" else 876543,
            "port": port,
            "data_dir": str(data_dir.resolve()),
            "token": "test-stop-token",
            "measurement_owner": owner,
        }
        (data_dir / "state.json").write_text(json.dumps(state), encoding="utf-8")

    signals = []
    stop_requests = []
    clock = iter(range(0, 1000, 10))
    monkeypatch.setattr(
        fixture_module,
        "_hello",
        lambda requested_port: {
            "runner": "grokbot-desk/1",
            "pid": pid,
            "port": requested_port,
        },
    )
    monkeypatch.setattr(fixture_module.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(fixture_module.time, "sleep", lambda _: None)
    monkeypatch.setattr(
        fixture_module.os,
        "kill",
        lambda target, sent_signal: signals.append((target, sent_signal)),
    )
    monkeypatch.setattr(
        fixture_module.urllib.request,
        "urlopen",
        lambda request, timeout: stop_requests.append(request)
        or type("Response", (), {"read": lambda self: b"{}"})(),
    )

    with pytest.raises(AssertionError, match="ownership"):
        fixture_module._stop_owned_server(env, port)

    assert stop_requests == []
    assert signals == []


def test_owned_process_handle_escalates_only_that_handle():
    calls = []

    class Process:
        def poll(self):
            return None

        def terminate(self):
            calls.append("terminate")

        def wait(self, timeout):
            calls.append(("wait", timeout))
            if calls.count(("wait", timeout)) == 1:
                raise subprocess.TimeoutExpired("owned-server", timeout)
            return 0

        def kill(self):
            calls.append("kill")

    fixture_module._terminate_owned_process(Process())

    assert calls == ["terminate", ("wait", 3), "kill", ("wait", 3)]


def test_cli_outer_timeout_exceeds_bounded_inner_budgets(monkeypatch):
    seen = []
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *args, **kwargs: seen.append(kwargs["timeout"])
        or subprocess.CompletedProcess(args[0], 0, "", ""),
    )
    env = {
        "RS_SERVER_START_TIMEOUT_MS": "15000",
        "RS_BROWSER_LAUNCH_TIMEOUT_MS": "30000",
        "RS_E2E_NAVIGATION_TIMEOUT_MS": "30000",
        "RS_E2E_READY_TIMEOUT_MS": "10000",
        "RS_SHOW_PROCESS_TIMEOUT_MS": "30000",
        "RS_TEST_CLI_TIMEOUT": "1",
    }

    cli(env, 18920, "check", "_starter")

    assert seen == [150]


def test_cli_timeout_reports_last_inner_stage(monkeypatch):
    def timeout(*args, **kwargs):
        Path(kwargs["env"]["RS_E2E_STAGE_FILE"]).write_text(
            "rs-e2e stage: launching browser",
            encoding="utf-8",
        )
        raise subprocess.TimeoutExpired(
            args[0],
            kwargs["timeout"],
            stderr="",
        )

    monkeypatch.setattr(subprocess, "run", timeout)

    with pytest.raises(AssertionError, match="launching browser"):
        cli({}, 18920, "check", "_starter")


def test_e2e_reports_server_browser_and_expectation_wait_stages():
    source = (ROOT / "tools" / "e2e.mjs").read_text(encoding="utf-8")

    assert "rs-e2e stage: starting server" in source
    assert "rs-e2e stage: launching browser" in source
    assert "rs-e2e stage: running expect checks" in source


def test_free_port_rotates_within_configured_test_range():
    first = free_port()
    second = free_port()

    assert 18920 <= first <= 18939
    assert 18920 <= second <= 18939
    assert first != second


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
def test_starter_check_succeeds_with_p6_expectation_backend(
    tmp_path, server_guard
):
    port = free_port()
    env = server_guard(
        dict(os.environ, RS_DATA_DIR=str(tmp_path / "data")),
        port,
    )
    checked = cli(env, port, "check", "_starter")
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
def test_read_only_template_commands_do_not_create_data_dir(
    tmp_path, server_guard
):
    data_dir = tmp_path / "must-not-exist"
    port = free_port()
    env = server_guard(
        dict(os.environ, RS_DATA_DIR=str(data_dir)),
        port,
    )
    assert cli(env, port, "list").returncode == 0
    checked = cli(env, port, "check", "_starter")
    assert checked.returncode == 0, checked.stderr
    assert not data_dir.exists()


def test_global_template_wraps_bare_data_with_neutral_agent_bot(
    tmp_path, server_guard
):
    data_dir = tmp_path / "data"
    port = free_port()
    env = server_guard(
        dict(os.environ, RS_DATA_DIR=str(data_dir)),
        port,
    )
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


def test_show_submit_wait_result_cancel_status_and_stop(
    tmp_path, server_guard
):
    data_dir = tmp_path / "data"
    port = free_port()
    env = server_guard(
        dict(os.environ, RS_DATA_DIR=str(data_dir)),
        port,
    )
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


def test_duplicate_run_id_is_invalid_payload(tmp_path, server_guard):
    data_dir = tmp_path / "data"
    port = free_port()
    env = server_guard(
        dict(os.environ, RS_DATA_DIR=str(data_dir)),
        port,
    )
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


def test_show_accepts_one_utf8_bom_from_file_and_stdin(
    tmp_path, server_guard
):
    data_dir = tmp_path / "data"
    port = free_port()
    env = server_guard(
        dict(os.environ, RS_DATA_DIR=str(data_dir)),
        port,
    )
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
