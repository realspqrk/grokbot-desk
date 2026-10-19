"""`check FILE`: a payload checked the way `show` checks it, without a desk."""
import json
import subprocess
import sys
from pathlib import Path

import pytest

from core import cli


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures" / "payloads"
INVALID = sorted((FIXTURES / "invalid").glob("*.json"))


def check(capsys, *argv):
    code = cli.main(["check", *argv])
    captured = capsys.readouterr()
    return code, captured.out, captured.err


@pytest.mark.parametrize("path", sorted(FIXTURES.glob("*.json")), ids=lambda path: path.stem)
def test_check_command_accepts_every_valid_fixture(capsys, path):
    assert check(capsys, str(path))[:2] == (0, "ok\n")


@pytest.mark.parametrize("path", INVALID, ids=lambda path: path.stem)
def test_check_command_reports_pointer(capsys, path):
    expect = json.loads(path.with_suffix(".expect").read_text(encoding="utf-8"))
    code, out, _ = check(capsys, str(path))
    assert code == 2
    pointer, _, message = out.strip().partition(": ")
    assert pointer == (expect["pointer"] or "/")
    assert expect["message"] in message


def test_check_reads_stdin_and_warns_on_stderr(tmp_path):
    payload = json.loads((FIXTURES / "read.json").read_text(encoding="utf-8"))
    payload["why"] = "One. Two. Three. Four sentences are too many for the banner."
    done = subprocess.run(
        [sys.executable, str(ROOT / "report_shell.py"), "check", "-"],
        input=json.dumps(payload).encode("utf-8"), capture_output=True, cwd=ROOT,
        env={**__import__("os").environ, "RS_DATA_DIR": str(tmp_path / "data")},
    )
    assert done.returncode == 0, done.stderr
    assert done.stdout.decode().strip() == "ok"
    assert "warning /why" in done.stderr.decode()


def test_check_names_a_missing_file_and_invalid_json(capsys, tmp_path):
    code, _, err = check(capsys, str(tmp_path / "missing.json"))
    assert code == 2 and "cannot read" in err
    broken = tmp_path / "broken.json"
    broken.write_text("{", encoding="utf-8")
    code, out, _ = check(capsys, str(broken))
    assert code == 2 and "invalid JSON" in out


def test_check_and_show_take_no_template(capsys):
    with pytest.raises(SystemExit):
        cli.main(["check", "decide-list", "--all"])
    capsys.readouterr()
