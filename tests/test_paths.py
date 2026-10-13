import base64
import contextlib
import json
import os
import socket
from pathlib import Path

import pytest

from core import migrate, paths, platform_darwin, platform_windows

PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def test_windows_data_dir_defaults_to_product_name(tmp_path, monkeypatch):
    monkeypatch.delenv("RS_DATA_DIR", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))

    assert platform_windows.default_data_dir("grokbot-desk") == tmp_path / "grokbot-desk"


def test_data_dir_override_wins_over_default_and_legacy(tmp_path, monkeypatch):
    override = tmp_path / "explicit"
    legacy = tmp_path / "spqrk-report-shell"
    legacy.mkdir()
    monkeypatch.setenv("RS_DATA_DIR", str(override))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))

    assert platform_windows.default_data_dir("grokbot-desk") == override.resolve()


def test_windows_data_dir_falls_back_to_existing_legacy_dir(tmp_path, monkeypatch):
    legacy = tmp_path / "spqrk-report-shell"
    legacy.mkdir()
    monkeypatch.delenv("RS_DATA_DIR", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))

    assert platform_windows.default_data_dir("grokbot-desk") == legacy


def test_macos_data_dir_uses_application_support(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.delenv("RS_DATA_DIR", raising=False)

    assert platform_darwin.default_data_dir("grokbot-desk") == (
        tmp_path / "Library" / "Application Support" / "grokbot-desk"
    )


def _legacy_with_run(local):
    runs = local / "spqrk-report-shell" / "runs"
    runs.mkdir(parents=True)
    (runs / "20261011-093000-bot-0123456789ab.json").write_text("{}")
    (local / "spqrk-report-shell" / "config.json").write_text('{"port": 18930}')


def _scan(base):
    from core.registry import scan_registry

    return scan_registry(paths.ROOT / "templates", base / "templates")


def _reload(base):
    from core.actionlog import ActionLog
    from core.runs import RunStore

    return RunStore(base, _scan(base), paths.load_config(base), ActionLog(base))


def _preview_with_legacy_media(local):
    """A preview-post run whose image lives in the legacy media folder, with
    config.json naming that folder as a media root."""
    from core.envelope import validate_payload

    legacy = paths.ensure_layout(local / "spqrk-report-shell")
    image = legacy / "media" / "photo.png"
    image.write_bytes(PNG_1PX)
    (legacy / "config.json").write_text(json.dumps({"media_roots": [str(legacy / "media")]}))
    store = _reload(legacy)
    detail = store.register(validate_payload({
        "schema": "report-shell/payload@1",
        "template": "preview-post",
        "version": 1,
        "bot": "example-bot",
        "title": "Post",
        "created": "2026-10-08T10:39:00+02:00",
        "data": {
            "author": {"name": "Example", "handle": "example"},
            "text": "Hello",
            "hashtags": [],
            "image": {"path": str(image), "alt": "One pixel", "ratio": "1:1"},
            "platforms": [{"platform": "linkedin", "mode": "auto"}],
        },
    }, store.registry))
    media_id = detail["data"]["image"]["path"]
    assert media_id in store.media
    return detail["run_id"], media_id


def test_migrate_moves_the_folder_and_a_reloaded_run_keeps_its_media(tmp_path):
    run_id, media_id = _preview_with_legacy_media(tmp_path)
    current = tmp_path / "grokbot-desk"

    summary = migrate.migrate(tmp_path)

    assert summary["migrated"] is True and summary["runs_rewritten"] == 1
    assert summary["config_rewritten"] is True
    assert not (tmp_path / "spqrk-report-shell").exists()
    config = json.loads((current / "config.json").read_text())
    assert config["media_roots"] == [str(current / "media")]
    record = (current / "runs" / f"{run_id}.json").read_text(encoding="utf-8")
    assert "spqrk-report-shell" not in record
    reloaded = _reload(current)
    assert media_id in reloaded.media
    assert reloaded.media[media_id].path == current / "media" / "photo.png"


def test_migrate_is_idempotent(tmp_path):
    _preview_with_legacy_media(tmp_path)
    assert migrate.migrate(tmp_path)["migrated"] is True
    runs = tmp_path / "grokbot-desk" / "runs"
    before = sorted(path.read_bytes() for path in runs.glob("*.json"))

    again = migrate.migrate(tmp_path)

    assert again["migrated"] is False and again["runs_rewritten"] == 0
    assert sorted(path.read_bytes() for path in runs.glob("*.json")) == before


def test_migrate_replaces_an_empty_new_dir_but_never_one_with_files(tmp_path):
    _legacy_with_run(tmp_path)
    paths.ensure_layout(tmp_path / "grokbot-desk")
    (tmp_path / "grokbot-desk" / "state.json").write_text("{}")
    assert migrate.migrate(tmp_path)["migrated"] is True
    assert (tmp_path / "grokbot-desk" / "config.json").exists()

    other = tmp_path / "other"
    _legacy_with_run(other)
    (other / "grokbot-desk" / "runs").mkdir(parents=True)
    (other / "grokbot-desk" / "runs" / "20261012-093000-bot-0123456789ab.json").write_text("{}")
    with pytest.raises(migrate.MigrationRefused) as refused:
        migrate.migrate(other)
    assert refused.value.code == 7 and "already holds files" in str(refused.value)
    assert (other / "spqrk-report-shell" / "runs").is_dir()


@pytest.mark.parametrize("how", ["lock", "port", "pending"])
def test_migrate_refuses_while_a_desk_runs_or_starts(tmp_path, how):
    _legacy_with_run(tmp_path)
    legacy = tmp_path / "spqrk-report-shell"
    with contextlib.ExitStack() as stack:
        if how == "lock":
            fd = migrate.hold_server_lock(legacy)
            assert fd is not None
            stack.callback(os.close, fd)
        elif how == "port":
            listener = stack.enter_context(socket.socket())
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            (legacy / "state.json").write_text(f'{{"port": {listener.getsockname()[1]}}}')
        else:
            (legacy / "migrate.pending").write_text("1")
        with pytest.raises(migrate.MigrationRefused) as refused:
            migrate.migrate(tmp_path)

    assert refused.value.code == 4
    assert (legacy / "runs" / "20261011-093000-bot-0123456789ab.json").exists()
    assert not (tmp_path / "grokbot-desk").exists()
    if how != "pending":
        assert not (legacy / "migrate.pending").exists()


def test_a_server_does_not_start_while_migrate_runs(tmp_path):
    from core.server import run_server

    base = paths.ensure_layout(tmp_path / "data")
    (base / "migrate.pending").write_text("1")
    with pytest.raises(migrate.DataDirBusy):
        run_server(base, 18923, paths.ROOT)
    moved = tmp_path / "spqrk-report-shell"
    with pytest.raises(migrate.DataDirBusy):
        run_server(moved, 18923, paths.ROOT)
    assert not moved.exists()


def test_failed_move_leaves_the_old_folder_untouched(tmp_path, monkeypatch):
    run_id, _ = _preview_with_legacy_media(tmp_path)
    legacy = tmp_path / "spqrk-report-shell"
    before = (legacy / "runs" / f"{run_id}.json").read_bytes()

    def refuse(*args):
        raise PermissionError(13, "in use")

    monkeypatch.setattr(migrate.os, "replace", refuse)
    with pytest.raises(OSError):
        migrate.migrate(tmp_path)

    assert (legacy / "runs" / f"{run_id}.json").read_bytes() == before
    assert not (legacy / "migrate.pending").exists()
    assert not (tmp_path / "grokbot-desk").exists()


def test_cli_migrate_never_touches_rs_data_dir(tmp_path, monkeypatch, capsys):
    from core import cli

    monkeypatch.setenv("RS_DATA_DIR", str(tmp_path / "explicit"))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    _legacy_with_run(tmp_path)

    assert cli.main(["migrate"]) == 0
    assert json.loads(capsys.readouterr().out)["migrated"] is False
    assert (tmp_path / "spqrk-report-shell" / "runs").is_dir()


def test_paths_names_migrate_while_the_legacy_folder_is_in_use(tmp_path, monkeypatch):
    monkeypatch.delenv("RS_DATA_DIR", raising=False)
    report = paths.data_dir_report(tmp_path / "spqrk-report-shell")
    assert report["source"] == "legacy"
    assert "report_shell.py migrate" in report["warning"]
    assert "warning" not in paths.data_dir_report(tmp_path / "grokbot-desk")
    monkeypatch.setenv("RS_DATA_DIR", str(tmp_path / "spqrk-report-shell"))
    assert "warning" not in paths.data_dir_report(tmp_path / "spqrk-report-shell")


def test_wait_follows_a_migrated_default_folder(tmp_path, monkeypatch):
    monkeypatch.delenv("RS_DATA_DIR", raising=False)
    legacy, current = tmp_path / "spqrk-report-shell", tmp_path / "grokbot-desk"
    assert paths.follow_migration(legacy) == legacy
    current.mkdir()
    assert paths.follow_migration(legacy) == current
    monkeypatch.setenv("RS_DATA_DIR", str(legacy))
    assert paths.follow_migration(legacy) == legacy


def test_default_media_dir_follows_selected_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "user"))
    base = tmp_path / "selected-data"

    assert paths.default_config(base)["media_roots"] == [
        str(tmp_path / "user" / "Downloads"),
        str(base / "media"),
    ]
