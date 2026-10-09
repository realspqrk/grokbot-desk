import json
import os
import secrets
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


def install_minimal_template(repo_root, template_id="_starter"):
    target = Path(repo_root) / "templates" / "global" / template_id
    target.mkdir(parents=True)
    files = {
        "template.json": {
            "id": template_id,
            "namespace": "global",
            "version": 1,
            "title_de": "Minimaler Testbericht",
            "description": "Test-owned minimal template.",
            "components": [],
            "strings": ["acknowledge"],
        },
        "schema.json": {
            "type": "object",
            "required": ["message"],
            "additionalProperties": False,
            "properties": {
                "message": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 200,
                }
            },
        },
        "result.schema.json": {
            "type": "object",
            "required": ["acknowledged"],
            "additionalProperties": False,
            "properties": {"acknowledged": {"const": True}},
        },
        "fixtures/golden.json": {"message": "Hello"},
        "fixtures/edge-max.json": {"message": "x" * 200},
        "fixtures/edge-unicode.json": {"message": "Grüße 👋 – 日本語"},
        "fixtures/invalid-empty.json": {"message": ""},
        "fixtures/invalid-type.json": {"message": 42},
    }
    for name, content in files.items():
        path = target / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(content, ensure_ascii=False),
            encoding="utf-8",
        )
    (target / "template.html").write_text(
        '<p data-rs-field="message"></p>',
        encoding="utf-8",
    )
    (target / "template.js").write_text(
        "root.querySelector('[data-rs-field=\"message\"]').textContent = "
        "RS.data.message;\n",
        encoding="utf-8",
    )
    (target / "template.css").write_text(
        ":host { display: block; }\n",
        encoding="utf-8",
    )
    (target / "README.md").write_text(
        "# Minimal test template\n",
        encoding="utf-8",
    )
    return target


TEST_PORT_FIRST = 18920
TEST_PORT_LAST = 18939
_next_test_port = TEST_PORT_FIRST


def free_port():
    global _next_test_port
    count = TEST_PORT_LAST - TEST_PORT_FIRST + 1
    for offset in range(count):
        port = TEST_PORT_FIRST + (
            _next_test_port - TEST_PORT_FIRST + offset
        ) % count
        with socket.socket() as sock:
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
            _next_test_port = (
                TEST_PORT_FIRST
                + (port - TEST_PORT_FIRST + 1) % count
            )
            return port
    raise RuntimeError(
        f"no free test port in {TEST_PORT_FIRST}-{TEST_PORT_LAST}"
    )


def _hello(port):
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/hello", timeout=.2
        ) as response:
            value = json.loads(response.read())
        if value.get("runner") == "grokbot-desk/1":
            return value
    except Exception:
        pass
    return None


def _stop_owned_server(env, port):
    hello = _hello(port)
    if not hello:
        return
    data_dir = Path(env["RS_DATA_DIR"]).resolve()
    owner = env.get("RS_MEASUREMENT_OWNER")
    try:
        state = json.loads((data_dir / "state.json").read_text())
        state_data_dir = Path(state["data_dir"]).resolve()
    except (KeyError, OSError, TypeError, ValueError):
        state = {}
        state_data_dir = None
    pid = state.get("pid")
    ownership_matches = (
        isinstance(owner, str)
        and bool(owner)
        and state.get("measurement_owner") == owner
        and isinstance(pid, int)
        and pid > 0
        and state.get("port") == port
        and state_data_dir == data_dir
        and isinstance(state.get("token"), str)
        and bool(state["token"])
        and hello.get("pid") == pid
        and hello.get("port") == port
    )
    if not ownership_matches:
        raise AssertionError(
            f"server ownership could not be proven for port {port}; "
            "refusing graceful stop or process signals"
        )
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/stop",
        method="POST",
        headers={
            "Host": f"127.0.0.1:{port}",
            "X-RS-Token": state["token"],
        },
        data=b"{}",
    )
    try:
        urllib.request.urlopen(request, timeout=1).read()
    except Exception as error:
        raise AssertionError(
            f"authenticated graceful stop failed for owned server on port {port}: "
            f"{error}"
        ) from error
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and _hello(port):
        time.sleep(.05)
    if _hello(port):
        raise AssertionError(
            f"owned server on port {port} did not stop gracefully; "
            "refusing process signals"
        )


def _terminate_owned_process(process):
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


@pytest.fixture
def server_guard():
    tracked = []

    def register(env, port):
        run_env = dict(env)
        run_env["RS_MEASUREMENT_OWNER"] = secrets.token_urlsafe(32)
        e2e_port = free_port()
        while e2e_port == port:
            e2e_port = free_port()
        run_env["RS_TOOL_PORT"] = str(port)
        run_env["RS_E2E_PORT"] = str(e2e_port)
        tracked.extend(((run_env, port), (run_env, e2e_port)))
        return run_env

    yield register
    seen = set()
    for env, port in reversed(tracked):
        if port not in seen:
            _stop_owned_server(env, port)
            seen.add(port)


@pytest.fixture
def isolated_env(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    monkeypatch.setenv("RS_DATA_DIR", str(data_dir))
    return data_dir


@pytest.fixture
def server_process(tmp_path):
    processes = []

    def start(env):
        port = free_port()
        run_env = dict(env)
        run_env["RS_DATA_DIR"] = str(tmp_path / f"data-{port}")
        process = subprocess.Popen(
            [sys.executable, str(ROOT / "report_shell.py"), "--port", str(port), "serve"],
            cwd=ROOT,
            env=run_env,
        )
        processes.append((process, run_env, port))
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/hello", timeout=.2):
                    return process, run_env, port
            except Exception:
                time.sleep(.05)
        raise AssertionError("server did not start")

    yield start
    for process, env, port in processes:
        _terminate_owned_process(process)
