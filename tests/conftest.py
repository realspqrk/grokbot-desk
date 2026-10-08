import json
import os
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


_next_test_port = None


def free_port():
    for port in range(18920, 18940):
        with socket.socket() as sock:
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError("no free test port in 18920-18939")


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
        try:
            state = json.loads((Path(env["RS_DATA_DIR"]) / "state.json").read_text())
            request = urllib.request.Request(
                f"http://127.0.0.1:{port}/stop",
                method="POST",
                headers={"Host": f"127.0.0.1:{port}", "X-RS-Token": state["token"]},
                data=b"{}",
            )
            urllib.request.urlopen(request, timeout=1).read()
        except Exception:
            process.terminate()
        process.wait(timeout=3)
