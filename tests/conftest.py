import errno
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

from core.product import RUNNER_ID


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
_next_test_port = None


def _loopback_refuses(port):
    with socket.socket() as probe:
        probe.settimeout(1)
        try:
            return (
                probe.connect_ex(("127.0.0.1", port))
                == errno.ECONNREFUSED
            )
        except OSError:
            return False


def _loopback_refuses(port):
    with socket.socket() as probe:
        probe.settimeout(1)
        try:
            return probe.connect_ex(("127.0.0.1", port)) == errno.ECONNREFUSED
        except OSError:
            return False


def free_port():
    global _next_test_port
    low = os.environ.get("RS_TEST_PORT_MIN")
    high = os.environ.get("RS_TEST_PORT_MAX")
    if (low is None) != (high is None):
        raise RuntimeError(
            "RS_TEST_PORT_MIN and RS_TEST_PORT_MAX must be set together"
        )
    first = int(low) if low is not None else TEST_PORT_FIRST
    last = int(high) if high is not None else TEST_PORT_LAST
    if not 1 <= first <= last <= 65535:
        raise RuntimeError("invalid test port range")
    if _next_test_port is None or not first <= _next_test_port <= last:
        _next_test_port = first
    for _ in range(last - first + 1):
        port = _next_test_port
        _next_test_port = first if port == last else port + 1
        if sys.platform == "win32":
            with socket.socket() as probe:
                probe.settimeout(.05)
                if probe.connect_ex(("127.0.0.1", port)) == 0:
                    continue
        elif not _loopback_refuses(port):
            continue
        with socket.socket() as sock:
            if sys.platform != "win32":
                sock.setsockopt(
                    socket.SOL_SOCKET,
                    socket.SO_REUSEADDR,
                    1,
                )
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
        return port
    raise RuntimeError(f"no free test port in {first}-{last}")


def _hello(port):
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/hello", timeout=.2
        ) as response:
            value = json.loads(response.read())
        if value.get("runner") == RUNNER_ID:
            return value
    except Exception:
        pass
    return None


def _startup_timeout_seconds(env, default=3):
    try:
        milliseconds = float(
            env.get("RS_SERVER_START_TIMEOUT_MS", default * 1000)
        )
    except (TypeError, ValueError):
        milliseconds = default * 1000
    if not milliseconds > 0:
        milliseconds = default * 1000
    return min(max(milliseconds / 1000, 1), 120)


def _stderr_tail(path, limit=8192):
    try:
        with Path(path).open("rb") as stream:
            stream.seek(0, os.SEEK_END)
            size = stream.tell()
            stream.seek(max(0, size - limit))
            return stream.read(limit).decode(
                "utf-8", errors="replace"
            )
    except OSError:
        return ""


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
        stderr_path = tmp_path / f"server-{port}.stderr.log"
        with stderr_path.open("w+b") as stderr:
            process = subprocess.Popen(
                [
                    sys.executable,
                    str(ROOT / "report_shell.py"),
                    "--port",
                    str(port),
                    "serve",
                ],
                cwd=ROOT,
                env=run_env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=stderr,
            )
        processes.append((process, run_env, port))
        startup_timeout = _startup_timeout_seconds(run_env)
        deadline = time.monotonic() + startup_timeout
        while time.monotonic() < deadline:
            if process.poll() is not None:
                break
            if _hello(port):
                return process, run_env, port
            time.sleep(.05)
        tail = _stderr_tail(stderr_path).rstrip() or "<empty>"
        status = (
            f"exit code {process.returncode}"
            if process.poll() is not None
            else "process still running"
        )
        raise AssertionError(
            f"server did not start within {startup_timeout:g} seconds "
            f"({status}); server stderr tail: {tail}"
        )

    yield start
    for process, env, port in processes:
        _terminate_owned_process(process)
