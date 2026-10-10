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


def test_default_media_dir_follows_selected_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "user"))
    base = tmp_path / "selected-data"

    assert paths.default_config(base)["media_roots"] == [
        str(tmp_path / "user" / "Downloads"),
        str(base / "media"),
    ]
