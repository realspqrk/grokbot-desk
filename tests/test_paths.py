from pathlib import Path

from core import paths, platform_darwin, platform_windows


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


def _reset_migration(monkeypatch):
    monkeypatch.setattr(paths, "MIGRATION", {"state": None, "warning": None})
    monkeypatch.setattr(paths, "_warned", False)


def test_legacy_dir_moves_once_to_the_product_name(tmp_path, monkeypatch):
    _reset_migration(monkeypatch)
    monkeypatch.delenv("RS_DATA_DIR", raising=False)
    _legacy_with_run(tmp_path)

    assert paths.migrate_legacy_data_dir(tmp_path)["state"] == "migrated"

    assert not (tmp_path / "spqrk-report-shell").exists()
    assert (tmp_path / "grokbot-desk" / "runs" / "20261011-093000-bot-0123456789ab.json").exists()
    assert (tmp_path / "grokbot-desk" / "config.json").exists()
    report = paths.data_dir_report(tmp_path / "grokbot-desk")
    assert report["reason"] == "migrated" and report["source"] == "default"
    # the next call finds nothing to do
    assert paths.migrate_legacy_data_dir(tmp_path)["state"] is None
    assert "reason" not in paths.data_dir_report(tmp_path / "grokbot-desk")


def test_legacy_dir_replaces_an_empty_new_dir_but_never_one_with_files(tmp_path, monkeypatch):
    _reset_migration(monkeypatch)
    monkeypatch.delenv("RS_DATA_DIR", raising=False)
    _legacy_with_run(tmp_path)
    for name in ("runs", "results", "log", "media"):
        (tmp_path / "grokbot-desk" / name).mkdir(parents=True)
    assert paths.migrate_legacy_data_dir(tmp_path)["state"] == "migrated"
    assert (tmp_path / "grokbot-desk" / "config.json").exists()

    _reset_migration(monkeypatch)
    other = tmp_path / "other"
    other.mkdir()
    _legacy_with_run(other)
    (other / "grokbot-desk" / "runs").mkdir(parents=True)
    (other / "grokbot-desk" / "runs" / "20261012-093000-bot-0123456789ab.json").write_text("{}")
    assert paths.migrate_legacy_data_dir(other)["state"] is None
    assert (other / "spqrk-report-shell" / "runs").is_dir()


def test_legacy_dir_stays_while_its_server_runs(tmp_path, monkeypatch):
    import socket

    _reset_migration(monkeypatch)
    monkeypatch.delenv("RS_DATA_DIR", raising=False)
    _legacy_with_run(tmp_path)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        (tmp_path / "spqrk-report-shell" / "state.json").write_text(f'{{"port": {port}}}')
        result = paths.migrate_legacy_data_dir(tmp_path)

    assert result["state"] == "live"
    assert (tmp_path / "spqrk-report-shell" / "runs").is_dir()
    assert not (tmp_path / "grokbot-desk").exists()
    report = paths.data_dir_report(tmp_path / "spqrk-report-shell")
    assert report["reason"] == "live" and report["warning"]


def test_failed_move_keeps_the_legacy_dir_and_warns_once(tmp_path, monkeypatch, capsys):
    _reset_migration(monkeypatch)
    monkeypatch.delenv("RS_DATA_DIR", raising=False)
    _legacy_with_run(tmp_path)

    def refuse(*args):
        raise PermissionError(13, "in use")

    monkeypatch.setattr(paths.os, "replace", refuse)
    assert paths.migrate_legacy_data_dir(tmp_path)["state"] == "failed"
    assert paths.migrate_legacy_data_dir(tmp_path)["state"] == "failed"

    assert (tmp_path / "spqrk-report-shell" / "runs").is_dir()
    assert capsys.readouterr().err.count("could not move") == 1


def test_rs_data_dir_is_never_migrated(tmp_path, monkeypatch):
    _reset_migration(monkeypatch)
    monkeypatch.setenv("RS_DATA_DIR", str(tmp_path / "explicit"))
    _legacy_with_run(tmp_path)

    assert paths.migrate_legacy_data_dir(tmp_path)["state"] is None
    assert (tmp_path / "spqrk-report-shell" / "runs").is_dir()


def test_migration_is_off_without_localappdata_and_on_macos(tmp_path, monkeypatch):
    _reset_migration(monkeypatch)
    monkeypatch.delenv("RS_DATA_DIR", raising=False)
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    assert paths.migrate_legacy_data_dir()["state"] is None
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    _legacy_with_run(tmp_path)
    monkeypatch.setattr(paths.sys, "platform", "darwin")
    assert paths.migrate_legacy_data_dir()["state"] is None
    assert (tmp_path / "spqrk-report-shell").is_dir()


def test_default_media_dir_follows_selected_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "user"))
    base = tmp_path / "selected-data"

    assert paths.default_config(base)["media_roots"] == [
        str(tmp_path / "user" / "Downloads"),
        str(base / "media"),
    ]
