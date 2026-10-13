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
    (legacy / "runs").mkdir(parents=True)
    monkeypatch.delenv("RS_DATA_DIR", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))

    assert platform_windows.default_data_dir("grokbot-desk") == legacy


def test_macos_data_dir_uses_application_support(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.delenv("RS_DATA_DIR", raising=False)

    assert platform_darwin.default_data_dir("grokbot-desk") == (
        tmp_path / "Library" / "Application Support" / "grokbot-desk"
    )


def _legacy_with_run(local, decided=True):
    runs = local / "spqrk-report-shell" / "runs"
    runs.mkdir(parents=True)
    (runs / "20261011-093000-bot-0123456789ab.json").write_text("{}")
    if decided:
        (local / "spqrk-report-shell" / "results").mkdir()
        (local / "spqrk-report-shell" / "results" / "20261011-093000-bot-0123456789ab.json").write_text("{}")
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

    legacy = local / "spqrk-report-shell"
    (legacy / "runs").mkdir(parents=True)
    paths.ensure_layout(legacy)
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


def _decide(base, run_id):
    from core.actionlog import ActionLog
    from core.runs import RunStore

    RunStore(base, _scan(base), paths.load_config(base), ActionLog(base)).decide(run_id, "cancelled")


def test_migrate_refuses_while_a_run_is_open_and_moves_once_decided(tmp_path):
    run_id, media_id = _preview_with_legacy_media(tmp_path)
    legacy, current = tmp_path / "spqrk-report-shell", tmp_path / "grokbot-desk"
    config = (legacy / "config.json").read_bytes()

    with pytest.raises(migrate.MigrationRefused) as refused:
        migrate.migrate(tmp_path)
    assert refused.value.code == 4 and "decide or discard open desks first" in str(refused.value)
    assert (legacy / "config.json").read_bytes() == config
    assert not current.exists() and not (legacy / "migrate.pending").exists()

    _decide(legacy, run_id)
    summary = migrate.migrate(tmp_path)

    assert summary["migrated"] is True and summary["config_rewritten"] is True
    assert not legacy.exists()
    assert json.loads((current / "config.json").read_text())["media_roots"] == [str(current / "media")]
    assert json.loads((current / "results" / f"{run_id}.json").read_text())["status"] == "cancelled"
    assert summary["runs_rewritten"] == 1
    assert "spqrk-report-shell" not in (current / "runs" / f"{run_id}.json").read_text(encoding="utf-8")
    assert migrate.migrate(tmp_path)["migrated"] is False


def test_a_submitted_report_keeps_its_media_after_migrate(tmp_path):
    from core.actionlog import ActionLog
    from core.runs import RunStore

    run_id, media_id = _preview_with_legacy_media(tmp_path)
    legacy, current = tmp_path / "spqrk-report-shell", tmp_path / "grokbot-desk"
    store = RunStore(legacy, _scan(legacy), paths.load_config(legacy), ActionLog(legacy))
    store.decide(run_id, "submitted", {
        "decision": "approve",
        "platforms": ["linkedin"],
        "comment": "",
        "per_platform": {"linkedin": {"mode": "auto", "decision": "approved"}},
    })

    assert migrate.migrate(tmp_path)["migrated"] is True

    reloaded = _reload(current)
    assert reloaded.detail(run_id)["state"] == "submitted"
    assert media_id in reloaded.media
    assert reloaded.media[media_id].path == current / "media" / "photo.png"


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


def test_a_server_does_not_start_while_migrate_runs(tmp_path, monkeypatch):
    from core.server import run_server

    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))

    base = paths.ensure_layout(tmp_path / "data")
    (base / "migrate.pending").write_text("1")
    with pytest.raises(migrate.DataDirBusy):
        run_server(base, 18923, paths.ROOT)
    moved = tmp_path / "spqrk-report-shell"
    with pytest.raises(migrate.DataDirBusy):
        run_server(moved, 18923, paths.ROOT)
    assert not moved.exists()


def test_failed_move_puts_the_old_config_back(tmp_path, monkeypatch):
    run_id, _ = _preview_with_legacy_media(tmp_path)
    legacy = tmp_path / "spqrk-report-shell"
    _decide(legacy, run_id)
    before = (legacy / "config.json").read_bytes()
    run_file = legacy / "runs" / f"{run_id}.json"
    run_before = run_file.read_bytes()
    real_replace = migrate.os.replace

    def refuse(source, target):
        if Path(source) == legacy:
            raise PermissionError(13, "in use")
        return real_replace(source, target)

    monkeypatch.setattr(migrate.os, "replace", refuse)
    with pytest.raises(OSError):
        migrate.migrate(tmp_path)

    assert (legacy / "config.json").read_bytes() == before
    assert run_file.read_bytes() == run_before
    assert not list(legacy.rglob("*.migrate.tmp"))
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
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    report = paths.data_dir_report(tmp_path / "spqrk-report-shell")
    assert report["source"] == "legacy"
    assert "report_shell.py migrate" in report["warning"]
    assert "warning" not in paths.data_dir_report(tmp_path / "grokbot-desk")
    monkeypatch.setenv("RS_DATA_DIR", str(tmp_path / "spqrk-report-shell"))
    assert "warning" not in paths.data_dir_report(tmp_path / "spqrk-report-shell")


def test_wait_follows_a_migrated_default_folder(tmp_path, monkeypatch):
    monkeypatch.delenv("RS_DATA_DIR", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    legacy, current = tmp_path / "spqrk-report-shell", tmp_path / "grokbot-desk"
    assert paths.follow_migration(legacy) == legacy
    current.mkdir()
    assert paths.follow_migration(legacy) == current
    (legacy / "log").mkdir(parents=True)  # a stray write after the move
    assert paths.follow_migration(legacy) == current
    monkeypatch.setenv("RS_DATA_DIR", str(legacy))
    assert paths.follow_migration(legacy) == legacy


def test_a_migrated_old_folder_is_never_created_again(tmp_path, monkeypatch):
    from core import cli
    from core.server import run_server

    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    legacy, current = tmp_path / "spqrk-report-shell", tmp_path / "grokbot-desk"
    assert paths.ensure_layout(legacy) == current
    assert not legacy.exists() and (current / "runs").is_dir()

    # a server spawned for the old folder just before migrate moved it
    monkeypatch.setenv("RS_DATA_DIR", str(legacy))
    assert cli.main(["--port", "18923", "serve"]) == 4
    assert not legacy.exists()
    (legacy / "log").mkdir(parents=True)  # a stray write after the move
    with pytest.raises(migrate.DataDirBusy):
        run_server(legacy, 18923, paths.ROOT)
    assert not (legacy / "runs").exists()


def test_an_explicit_data_dir_with_the_old_name_is_used_as_given(tmp_path, monkeypatch, capsys):
    """Only the real default old folder is redirected. A custom RS_DATA_DIR
    that happens to carry the old name is a new, empty folder like any
    other: new, show (ensure_layout) and serve all use it."""
    from core import cli, server

    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    explicit = (tmp_path / "custom" / "spqrk-report-shell").resolve()
    monkeypatch.setenv("RS_DATA_DIR", str(explicit))

    assert paths.data_dir() == explicit
    assert paths.ensure_layout(paths.data_dir()) == explicit
    assert (explicit / "runs").is_dir() and not (explicit.parent / "grokbot-desk").exists()
    assert paths.follow_migration(explicit) == explicit
    assert paths.migration_advice(explicit) is None
    assert paths.data_dir_report(explicit)["source"] == "RS_DATA_DIR"

    assert cli.main(["new", "example/review-test"]) == 0
    capsys.readouterr()
    assert (explicit / "templates" / "review-test").is_dir()
    assert "review-test" in _scan(explicit)

    served = []
    monkeypatch.setattr(server, "_serve", lambda base, port, root: served.append(Path(base)))
    for name in ("runs", "results"):
        os.rmdir(explicit / name)  # a fresh folder: serve lays it out itself
    server.run_server(explicit, 18923, paths.ROOT)
    assert served == [explicit] and (explicit / "runs").is_dir()


def test_wait_reads_a_result_moved_by_migrate_after_it_was_seen(tmp_path, monkeypatch, capsys):
    from core import cli

    monkeypatch.delenv("RS_DATA_DIR", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    _legacy_with_run(tmp_path)
    legacy, current = tmp_path / "spqrk-report-shell", tmp_path / "grokbot-desk"
    run_id = "20261011-093000-bot-0123456789ab"
    (legacy / "results" / f"{run_id}.json").write_text('{"status": "approve"}')
    real_read = Path.read_text

    def move_first(path, *args, **kwargs):
        if path == legacy / "results" / f"{run_id}.json" and legacy.exists():
            os.replace(legacy, current)
        return real_read(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", move_first)
    args = cli.build_parser().parse_args(["wait", run_id, "--timeout", "2"])

    assert cli.command_wait(args, legacy) == 0
    answer = json.loads(capsys.readouterr().out)
    assert answer["status"] == "approve" and answer["data_dir"] == str(current)


def test_wait_finds_a_run_moved_by_migrate_before_its_first_lookup(tmp_path, monkeypatch, capsys):
    from core import cli

    monkeypatch.delenv("RS_DATA_DIR", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    _legacy_with_run(tmp_path)
    legacy, current = tmp_path / "spqrk-report-shell", tmp_path / "grokbot-desk"
    run_id = "20261011-093000-bot-0123456789ab"
    (legacy / "results" / f"{run_id}.json").write_text('{"status": "approve"}')
    real_exists = Path.exists

    def move_first(path, *args, **kwargs):
        if path == legacy / "runs" / f"{run_id}.json" and real_exists(legacy):
            assert migrate.migrate(tmp_path)["migrated"] is True
        return real_exists(path, *args, **kwargs)

    monkeypatch.setattr(Path, "exists", move_first)
    args = cli.build_parser().parse_args(["wait", run_id, "--timeout", "2"])

    assert cli.command_wait(args, legacy) == 0
    answer = json.loads(capsys.readouterr().out)
    assert answer["status"] == "approve" and answer["data_dir"] == str(current)


def test_wait_keeps_an_explicit_data_dir_fixed(tmp_path, monkeypatch, capsys):
    from core import cli

    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    legacy, current = tmp_path / "spqrk-report-shell", tmp_path / "grokbot-desk"
    monkeypatch.setenv("RS_DATA_DIR", str(legacy))
    (current / "results").mkdir(parents=True)
    run_id = "20261011-093000-bot-0123456789ab"
    (current / "results" / f"{run_id}.json").write_text('{"status": "approve"}')
    args = cli.build_parser().parse_args(["wait", run_id, "--timeout", "1"])

    assert cli.command_wait(args, legacy) == 6
    assert "unknown run" in capsys.readouterr().err


def test_default_media_dir_follows_selected_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "user"))
    base = tmp_path / "selected-data"

    assert paths.default_config(base)["media_roots"] == [
        str(tmp_path / "user" / "Downloads"),
        str(base / "media"),
    ]
