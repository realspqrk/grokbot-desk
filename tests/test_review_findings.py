import ctypes
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from tools import clipread, measure_copy, measure_result


def test_clipread_import_is_safe_without_windll(monkeypatch):
    source = Path(clipread.__file__).read_text(encoding="utf-8")
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.delattr(ctypes, "WinDLL", raising=False)
    namespace = {"__name__": "tools.clipread_non_windows"}

    exec(compile(source, clipread.__file__, "exec"), namespace)

    assert namespace["user32"] is None
    assert namespace["kernel32"] is None


@pytest.mark.skipif(sys.platform != "win32", reason="Win32 clipboard API test")
def test_round_2_finding_4_null_clipboard_handle_is_reported_as_failure(
    monkeypatch, capsys
):
    class User32:
        @staticmethod
        def IsClipboardFormatAvailable(format_id):
            return True

        @staticmethod
        def OpenClipboard(owner):
            return True

        @staticmethod
        def GetClipboardData(format_id):
            return 0

        @staticmethod
        def CloseClipboard():
            return True

    monkeypatch.setattr(clipread, "user32", User32())

    assert clipread.main() == 1
    output = json.loads(capsys.readouterr().out)
    assert output["ok"] is False
    assert output["available"] is False
    assert "GetClipboardData failed" in output["error"]


def test_finding_2_failed_clipboard_snapshot_aborts_before_real_copy(monkeypatch, capsys):
    monkeypatch.setattr(measure_copy, "_expected_copy_count", lambda: 20, raising=False)
    monkeypatch.setattr(
        measure_copy,
        "_clipboard",
        lambda: {
            "ok": False,
            "available": False,
            "text": None,
            "error": "OpenClipboard failed",
        },
    )
    copy_run = pytest.fail
    monkeypatch.setattr(measure_copy.subprocess, "run", copy_run)
    monkeypatch.setattr(measure_copy, "write_text", pytest.fail)

    assert measure_copy.main() == 1
    output = json.loads(capsys.readouterr().out)
    assert output["ok"] is False
    assert output["error"] == "OpenClipboard failed"
    assert output["clipboard_snapshot"]["ok"] is False


def test_finding_2_successful_snapshot_without_text_needs_no_restore(monkeypatch, capsys):
    monkeypatch.setattr(measure_copy, "_expected_copy_count", lambda: 20, raising=False)
    monkeypatch.setattr(
        measure_copy,
        "_clipboard",
        lambda: {"ok": True, "available": False, "text": None},
    )
    monkeypatch.setattr(
        measure_copy.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=0,
            stdout=json.dumps({"ok": True, "passed": 20, "total": 20}),
            stderr="",
        ),
    )
    monkeypatch.setattr(measure_copy, "write_text", pytest.fail)

    assert measure_copy.main() == 0
    output = json.loads(capsys.readouterr().out)
    assert output["clipboard_restore"] == {
        "had_text": False,
        "required": False,
        "restored": False,
        "error": None,
    }


def test_copy_measurement_with_too_few_cases_never_reads_or_writes_clipboard(
    monkeypatch, capsys
):
    monkeypatch.setattr(measure_copy, "_expected_copy_count", lambda: 1)
    monkeypatch.setattr(measure_copy, "_clipboard", pytest.fail)
    monkeypatch.setattr(measure_copy.subprocess, "run", pytest.fail)
    monkeypatch.setattr(measure_copy, "write_text", pytest.fail)

    assert measure_copy.main() == 1
    output = json.loads(capsys.readouterr().out)
    assert output["ok"] is False
    assert output["total"] == 1
    assert "at least 20" in output["error"]


def test_round_2_finding_8_sufficient_copy_count_reaches_snapshot(monkeypatch, capsys):
    snapshots = []
    monkeypatch.setattr(measure_copy, "_expected_copy_count", lambda: 20)
    monkeypatch.setattr(
        measure_copy,
        "_clipboard",
        lambda: snapshots.append(True)
        or {"ok": False, "available": False, "error": "snapshot stopped"},
    )
    monkeypatch.setattr(measure_copy.subprocess, "run", pytest.fail)
    monkeypatch.setattr(measure_copy, "write_text", pytest.fail)

    assert measure_copy.main() == 1
    assert snapshots == [True]
    assert json.loads(capsys.readouterr().out)["error"] == "snapshot stopped"


def test_round_2_finding_7_prior_clipboard_text_never_reaches_measurement_output(
    monkeypatch, capsys
):
    sentinel = "SCRATCH-PRIVATE-CLIPBOARD"
    restored = []
    monkeypatch.setattr(measure_copy, "_expected_copy_count", lambda: 20)
    monkeypatch.setattr(
        measure_copy,
        "_clipboard",
        lambda: {"ok": True, "available": True, "text": sentinel},
    )
    monkeypatch.setattr(
        measure_copy.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=0,
            stdout=json.dumps({"ok": True, "passed": 20, "total": 20}),
            stderr="",
        ),
    )
    monkeypatch.setattr(measure_copy, "write_text", restored.append)

    assert measure_copy.main() == 0
    raw = capsys.readouterr().out
    output = json.loads(raw)
    assert restored == [sentinel]
    assert sentinel not in raw
    assert "text" not in output["clipboard_snapshot"]
    assert output["clipboard_snapshot"]["length"] == len(sentinel)
    assert len(output["clipboard_snapshot"]["sha256"]) == 64


def test_publish_guide_opening_is_self_contained():
    opening = (Path(__file__).resolve().parents[1] / "docs" / "GUIDE.md").read_text(
        encoding="utf-8"
    ).split("Entry point", 1)[0]

    assert "docs\\specs\\" not in opening
    assert "spec section" not in opening.lower()


@pytest.mark.parametrize(
    ("returncode", "payload", "message"),
    [
        (1, {"ok": True, "total": 20, "max_ms": 1, "cases": []}, "exited 1"),
        (0, {"ok": True, "total": 20, "max_ms": 1, "cases": []}, "exactly 20"),
    ],
)
def test_finding_14_failed_or_empty_submit_measurement_cannot_pass(
    monkeypatch, capsys, returncode, payload, message
):
    monkeypatch.setattr(
        measure_result.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=returncode,
            stdout=json.dumps(payload),
            stderr="submit failed" if returncode else "",
        ),
    )

    assert measure_result.main() == 1
    output = json.loads(capsys.readouterr().out)
    assert output["ok"] is False
    assert message in output["error"]


def test_round_4_finding_6_c10_requires_validation_inside_each_timed_case(
    monkeypatch, capsys
):
    expected = json.loads(
        (
            measure_result.ROOT
            / "templates"
                / "builtin"
            / "_starter"
            / "fixtures"
            / "expect"
            / "golden.json"
        ).read_text(encoding="utf-8")
    )["result"]
    cases = [
        {
            "run_id": f"r{index}",
            "template": "_starter",
            "ms": 1,
            "result": {"data": expected},
            "expected": expected,
        }
        for index in range(20)
    ]
    monkeypatch.setattr(
        measure_result.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=0,
            stdout=json.dumps({"ok": True, "cases": cases}),
            stderr="",
        ),
    )

    assert measure_result.main() == 1
    output = json.loads(capsys.readouterr().out)
    assert any(
        "timed validation" in item["error"]
        for item in output["validation_findings"]
    )
