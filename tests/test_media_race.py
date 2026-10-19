"""Media-root containment when a folder or file is swapped for a link.

Registration resolves the path and checks it against the configured media
roots. Serve and reload open the saved path again and check the handle's
final path: a folder or file replaced by a link to somewhere outside after
registration is not served. (The template-folder races these tests once
covered went with the templates.)
"""
import os
import subprocess
import sys

import pytest

from core.actionlog import ActionLog
from core.envelope import validate_payload
from core.media import MediaError, open_validated_media
from core.paths import ensure_layout, load_config
from core.runs import RunStore


OUTSIDE = b"OUTSIDE_PRIVATE_MEDIA"
INSIDE = b"INSIDE_MEDIA_ROOT"


def _make_dir_link(link, target):
    if sys.platform == "win32":
        made = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True)
        if made.returncode:
            pytest.skip("junction creation unavailable")
        return
    try:
        link.symlink_to(target, target_is_directory=True)
    except OSError as error:
        pytest.skip(f"symlink creation unavailable: {error}")


def _remove_dir_link(link):
    if sys.platform == "win32":
        os.rmdir(link)
    else:
        link.unlink()


def _make_file_symlink(link, target):
    try:
        link.symlink_to(target, target_is_directory=False)
    except OSError as error:
        pytest.skip(f"symlink creation unavailable: {error}")


def _setup(tmp_path):
    root = tmp_path / "media"
    folder = root / "shots"
    folder.mkdir(parents=True)
    (folder / "photo.png").write_bytes(INSIDE)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "photo.png").write_bytes(OUTSIDE)
    data_dir = ensure_layout(tmp_path / "data")
    config = dict(load_config(data_dir), media_roots=[str(root)])
    store = RunStore(data_dir, config, ActionLog(data_dir))
    return store, data_dir, config, folder, outside


def _show(store, path):
    detail = store.register(validate_payload({
        "schema": "grokbot-desk/payload@2", "bot": "example-bot", "title": "Media",
        "created": "2026-10-08T10:39:00+02:00", "ask": "read",
        "blocks": [{"type": "media", "path": str(path), "alt": "Photo"}],
    }))
    return detail["blocks"][0]["path"]


def _served(store, media_id):
    with open_validated_media(store.media[media_id], store.media_roots(media_id)) as (handle, _):
        return handle.read()


def test_a_folder_swapped_for_a_link_after_registration_is_not_served(tmp_path):
    store, data_dir, config, folder, outside = _setup(tmp_path)
    media_id = _show(store, folder / "photo.png")
    assert _served(store, media_id) == INSIDE
    folder.rename(tmp_path / "original-shots")
    _make_dir_link(folder, outside)
    try:
        with pytest.raises(MediaError):
            _served(store, media_id)
        reloaded = RunStore(data_dir, config, ActionLog(data_dir))
        assert media_id not in reloaded.media
    finally:
        _remove_dir_link(folder)


def test_a_file_swapped_for_a_symlink_after_registration_is_not_served(tmp_path):
    store, data_dir, config, folder, outside = _setup(tmp_path)
    media_id = _show(store, folder / "photo.png")
    photo = folder / "photo.png"
    photo.unlink()
    _make_file_symlink(photo, outside / "photo.png")
    try:
        with pytest.raises(MediaError):
            _served(store, media_id)
        reloaded = RunStore(data_dir, config, ActionLog(data_dir))
        assert media_id not in reloaded.media
    finally:
        if photo.is_symlink():
            photo.unlink()


def test_a_symlink_out_of_the_root_is_refused_at_registration(tmp_path):
    store, data_dir, _, folder, outside = _setup(tmp_path)
    link = folder / "link.png"
    _make_file_symlink(link, outside / "photo.png")
    with pytest.raises(MediaError, match="outside configured roots"):
        _show(store, link)
    assert not store.media and store.open_count() == 0
    assert not list((data_dir / "runs").glob("*.json"))
