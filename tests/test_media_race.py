"""Template-media containment across a directory swapped for a link.

RunStore.register used to read the schema, then let register_media resolve
%RS_TEMPLATE% again. A junction or symlink put in place of the template
folder in that window was treated as the media root. The same re-resolve on
reload served the replaced target. These tests swap the folder on purpose.
"""
import base64
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import pytest

from conftest import ROOT, install_minimal_template
from core.actionlog import ActionLog
from core.envelope import validate_payload
from core.media import TEMPLATE_TOKEN, MediaError, open_validated_media
from core.paths import ensure_layout, load_config
from core.registry import Template, scan_registry
from core.runs import RunStore


OUTSIDE = b"OUTSIDE_PRIVATE_MEDIA"
INSIDE = b"INSIDE_TEMPLATE_MEDIA"
PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def _make_dir_link(link, target, kind):
    if kind == "junction":
        if sys.platform != "win32":
            pytest.skip("junctions are Windows-specific")
        made = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True,
        )
        if made.returncode:
            detail = (made.stderr or made.stdout).decode(errors="replace")
            pytest.skip(f"junction creation unavailable: {detail}")
        return
    try:
        link.symlink_to(target, target_is_directory=True)
    except OSError as error:
        pytest.skip(f"symlink creation unavailable: {error}")


def _remove_dir_link(link, kind):
    if not link.exists() and not link.is_symlink():
        return
    if kind == "junction":
        os.rmdir(link)
    else:
        link.unlink()


def _make_file_symlink(link, target):
    try:
        link.symlink_to(target, target_is_directory=False)
    except OSError as error:
        pytest.skip(f"symlink creation unavailable: {error}")


def _media_template(parent, template_id="child", namespace="example-bot"):
    folder = parent / template_id
    folder.mkdir(parents=True)
    (folder / "photo.png").write_bytes(INSIDE)
    manifest = {
        "id": template_id,
        "namespace": namespace,
        "version": 1,
        "title_de": "Medien",
        "description": "Template with one image.",
        "components": [],
        "strings": [],
    }
    schema = {
        "type": "object",
        "additionalProperties": False,
        "required": ["image"],
        "properties": {
            "image": {"type": "string", "minLength": 1, "x-rs-media": True},
        },
    }
    result = {
        "type": "object",
        "additionalProperties": False,
        "properties": {"ok": {"const": True}},
    }
    files = {
        "template.json": manifest,
        "schema.json": schema,
        "result.schema.json": result,
        "fixtures/golden.json": {"image": TEMPLATE_TOKEN + "\\photo.png"},
    }
    for name, content in files.items():
        path = folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(content), encoding="utf-8")
    (folder / "template.html").write_text("<p></p>", encoding="utf-8")
    (folder / "template.js").write_text("", encoding="utf-8")
    (folder / "template.css").write_text("", encoding="utf-8")
    (folder / "README.md").write_text("# Medien\n", encoding="utf-8")
    return folder


def _store(tmp_path, registry):
    data_dir = ensure_layout(tmp_path / "data")
    return RunStore(data_dir, registry, load_config(data_dir), ActionLog(data_dir)), data_dir


def _payload(registry, template_id="child"):
    return validate_payload({
        "schema": "report-shell/payload@1",
        "template": template_id,
        "version": 1,
        "bot": "example-bot",
        "title": "Medien",
        "created": "2026-10-08T10:39:00+02:00",
        "data": {"image": TEMPLATE_TOKEN + "\\photo.png"},
    }, registry)


def _registry(tmp_path):
    repo = tmp_path / "repo"
    user = tmp_path / "user-templates"
    folder = _media_template(user)
    registry = scan_registry(repo / "templates", user)
    return registry, folder


@pytest.mark.parametrize("kind", ["junction", "dir-symlink"])
def test_swap_before_media_registration_does_not_authorize_outside_media(tmp_path, kind):
    registry, folder = _registry(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "photo.png").write_bytes(OUTSIDE)
    store, data_dir = _store(tmp_path, registry)
    payload = _payload(registry)
    link = None

    def swap(template):
        nonlocal link
        assert template.path == folder.resolve()
        backup = tmp_path / "original-template"
        folder.rename(backup)
        link = ("pending", kind)
        _make_dir_link(folder, outside, kind)
        link = (folder, kind)

    store.before_media_registration = swap
    try:
        with pytest.raises(MediaError):
            store.register(payload)
    finally:
        if isinstance(link, tuple) and link[0] != "pending":
            _remove_dir_link(folder, kind)
    assert payload["run_id"] not in store.ids()
    assert not (data_dir / "runs" / f"{payload['run_id']}.json").exists()
    assert not store.media


def test_replaced_real_directory_keeps_the_registry_identity(tmp_path):
    registry, folder = _registry(tmp_path)
    store, _ = _store(tmp_path, registry)
    payload = _payload(registry)
    pinned = registry["child"].root_identity

    def swap(template):
        assert template.root_identity == pinned
        backup = tmp_path / "original-template"
        folder.rename(backup)
        folder.mkdir()
        (folder / "photo.png").write_bytes(OUTSIDE)

    store.before_media_registration = swap
    with pytest.raises(MediaError):
        store.register(payload)
    assert not store.media
    assert payload["run_id"] not in store.ids()


def test_swap_between_registration_and_serve_is_not_served(tmp_path):
    registry, folder = _registry(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "photo.png").write_bytes(OUTSIDE)
    store, data_dir = _store(tmp_path, registry)
    detail = store.register(_payload(registry))
    media_id = detail["data"]["image"]
    backup = tmp_path / "original-template"
    kind = "junction" if sys.platform == "win32" else "dir-symlink"
    folder.rename(backup)
    _make_dir_link(folder, outside, kind)
    try:
        entry = store.media[media_id]
        with pytest.raises(MediaError):
            with open_validated_media(entry, store.media_roots(media_id)) as (handle, _):
                assert handle.read() != OUTSIDE
        reloaded = RunStore(data_dir, registry, load_config(data_dir), ActionLog(data_dir))
        assert media_id not in reloaded.media
    finally:
        _remove_dir_link(folder, kind)


def test_file_symlink_between_registration_and_serve_is_not_served(tmp_path):
    registry, folder = _registry(tmp_path)
    outside = tmp_path / "outside.png"
    outside.write_bytes(OUTSIDE)
    store, data_dir = _store(tmp_path, registry)
    detail = store.register(_payload(registry))
    media_id = detail["data"]["image"]
    photo = folder / "photo.png"
    photo.unlink()
    _make_file_symlink(photo, outside)
    try:
        with pytest.raises(MediaError):
            with open_validated_media(store.media[media_id], store.media_roots(media_id)) as (handle, _):
                assert handle.read() != OUTSIDE
        reloaded = RunStore(data_dir, store.registry, store.config, ActionLog(data_dir))
        assert media_id not in reloaded.media
    finally:
        if photo.is_symlink():
            photo.unlink()


def test_file_symlink_at_registration_is_rejected(tmp_path):
    registry, folder = _registry(tmp_path)
    outside = tmp_path / "outside.png"
    outside.write_bytes(OUTSIDE)
    photo = folder / "photo.png"
    photo.unlink()
    _make_file_symlink(photo, outside)
    try:
        store, _ = _store(tmp_path, registry)
        with pytest.raises(MediaError):
            store.register(_payload(registry))
    finally:
        if photo.is_symlink():
            photo.unlink()


def test_in_template_file_symlink_is_rejected(tmp_path):
    registry, folder = _registry(tmp_path)
    real = folder / "other.png"
    real.write_bytes(INSIDE)
    photo = folder / "photo.png"
    photo.unlink()
    _make_file_symlink(photo, real)
    try:
        store, _ = _store(tmp_path, registry)
        with pytest.raises(MediaError):
            store.register(_payload(registry))
    finally:
        if photo.is_symlink():
            photo.unlink()


def test_normal_template_media_registers_reloads_and_serves(tmp_path):
    registry, folder = _registry(tmp_path)
    store, data_dir = _store(tmp_path, registry)
    template = registry["child"]
    detail = store.register(_payload(registry))
    media_id = detail["data"]["image"]
    entry = store.media[media_id]
    assert entry.root_identity == template.root_identity
    assert entry.file_identity
    with open_validated_media(entry, store.media_roots(media_id)) as (handle, _):
        assert handle.read() == INSIDE
    saved = json.loads((data_dir / "runs" / f"{detail['run_id']}.json").read_text(encoding="utf-8"))
    assert saved["media"][media_id]["file_identity"] == [str(part) for part in entry.file_identity]
    reloaded = RunStore(data_dir, registry, load_config(data_dir), ActionLog(data_dir))
    with open_validated_media(reloaded.media[media_id], reloaded.media_roots(media_id)) as (handle, _):
        assert handle.read() == INSIDE


def test_builtin_review_doc_media_still_registers(tmp_path):
    registry = scan_registry(ROOT / "templates")
    data = json.loads(
        (ROOT / "templates" / "builtin" / "review-doc" / "fixtures" / "edge-max.json").read_text(encoding="utf-8")
    )
    payload = validate_payload({
        "schema": "report-shell/payload@1",
        "template": "review-doc",
        "version": 1,
        "bot": "example-bot",
        "title": "Bericht",
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "data": data,
    }, registry)
    store, _ = _store(tmp_path, registry)
    detail = store.register(payload)
    media_id = detail["data"]["images"][0]["path"]
    chart = ROOT / "templates" / "builtin" / "review-doc" / "fixtures" / "media" / "harvest-chart.png"
    with open_validated_media(store.media[media_id], store.media_roots(media_id)) as (handle, _):
        assert handle.read() == chart.read_bytes()


def test_extending_template_serves_own_media_and_inherited_assets(tmp_path):
    repo = tmp_path / "repo"
    base = install_minimal_template(repo, "base")
    builtin = repo / "templates" / "builtin" / "base"
    builtin.parent.mkdir(parents=True)
    shutil.move(str(base), str(builtin))
    user = tmp_path / "user-templates"
    child = _media_template(user, "custom", "example-bot")
    manifest = json.loads((child / "template.json").read_text(encoding="utf-8"))
    manifest["extends"] = "base"
    (child / "template.json").write_text(json.dumps(manifest), encoding="utf-8")
    for name in ("template.html", "template.css", "template.js"):
        (child / name).unlink()
    registry = scan_registry(repo / "templates", user)
    template = registry["custom"]
    assert template.file_path("template.html") == builtin / "template.html"
    assert template.read_text("template.html") == (builtin / "template.html").read_text(encoding="utf-8")
    store, _ = _store(tmp_path, registry)
    detail = store.register(_payload(registry, "custom"))
    with open_validated_media(store.media[detail["data"]["image"]], []) as (handle, _):
        assert handle.read() == INSIDE


def test_template_media_opens_non_bmp_directory_and_filename(tmp_path):
    registry, folder = _registry(tmp_path)
    nested = folder / "dir\U0001f600"
    nested.mkdir()
    (nested / "smile\U0001f600.png").write_bytes(b"EMOJI")
    relative = "dir\U0001f600\\smile\U0001f600.png"
    store, data_dir = _store(tmp_path, registry)
    payload = validate_payload({
        "schema": "report-shell/payload@1",
        "template": "child",
        "version": 1,
        "bot": "example-bot",
        "title": "Emoji",
        "created": "2026-10-08T10:39:00+02:00",
        "data": {"image": TEMPLATE_TOKEN + "\\" + relative},
    }, registry)
    detail = store.register(payload)
    media_id = detail["data"]["image"]
    with open_validated_media(store.media[media_id], store.media_roots(media_id)) as (handle, _):
        assert handle.read() == b"EMOJI"
    reloaded = RunStore(data_dir, registry, load_config(data_dir), ActionLog(data_dir))
    with open_validated_media(reloaded.media[media_id], reloaded.media_roots(media_id)) as (handle, _):
        assert handle.read() == b"EMOJI"


def _absolute_image_payload(registry, image):
    return validate_payload({
        "schema": "report-shell/payload@1",
        "template": "child",
        "version": 1,
        "bot": "example-bot",
        "title": "Datei",
        "created": "2026-10-08T10:39:00+02:00",
        "data": {"image": str(image)},
    }, registry)


def test_reload_revalidates_current_roots_and_rejects_forged_records(tmp_path):
    registry, _folder = _registry(tmp_path)
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    image = allowed / "ok.png"
    image.write_bytes(b"ORIGINALLY_ALLOWED")
    outside = tmp_path / "outside"
    outside.mkdir()
    secret = outside / "secret.png"
    secret.write_bytes(b"OUTSIDE_PRIVATE_MEDIA")
    data_dir = ensure_layout(tmp_path / "data")
    config = load_config(data_dir)
    config["media_roots"] = [str(allowed)]
    store = RunStore(data_dir, registry, config, ActionLog(data_dir))
    detail = store.register(_absolute_image_payload(registry, image))
    media_id = detail["data"]["image"]
    assert store.media[media_id].file_identity is None
    assert store.media[media_id].root_identity is None

    kept = RunStore(data_dir, registry, config, ActionLog(data_dir))
    assert media_id in kept.media
    with open_validated_media(kept.media[media_id], kept.media_roots(media_id)) as (handle, _):
        assert handle.read() == b"ORIGINALLY_ALLOWED"

    config["media_roots"] = []
    revoked = RunStore(data_dir, registry, config, ActionLog(data_dir))
    assert media_id not in revoked.media

    saved = data_dir / "runs" / f"{detail['run_id']}.json"
    record = json.loads(saved.read_text(encoding="utf-8"))
    item = record["media"][media_id]
    item["path"] = str(secret)
    item["roots"] = [str(outside)]
    item.pop("file_identity", None)
    item.pop("root_identity", None)
    saved.write_text(json.dumps(record), encoding="utf-8")
    forged = RunStore(data_dir, registry, config, ActionLog(data_dir))
    assert media_id not in forged.media
    assert all(entry.path != secret for entry in forged.media.values())


@pytest.mark.parametrize("drop", ["both", "file-only", "root-only"])
def test_reload_without_identity_fields_does_not_unpin_template_media(tmp_path, drop):
    registry, _folder = _registry(tmp_path)
    store, data_dir = _store(tmp_path, registry)
    detail = store.register(_payload(registry))
    media_id = detail["data"]["image"]
    saved = data_dir / "runs" / f"{detail['run_id']}.json"
    record = json.loads(saved.read_text(encoding="utf-8"))
    item = record["media"][media_id]
    assert item["file_identity"] and item["root_identity"]
    if drop in {"both", "file-only"}:
        item.pop("file_identity")
    if drop in {"both", "root-only"}:
        item.pop("root_identity")
    saved.write_text(json.dumps(record), encoding="utf-8")
    reloaded = RunStore(data_dir, registry, load_config(data_dir), ActionLog(data_dir))
    assert media_id not in reloaded.media


def _note_template(parent):
    folder = parent / "child"
    folder.mkdir(parents=True)
    (folder / "face.png").write_bytes(PNG_1PX)
    manifest = {
        "id": "child",
        "namespace": "example-bot",
        "version": 1,
        "title_de": "Notiz",
        "description": "Template with no media field.",
        "components": [],
        "strings": [],
    }
    schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {"note": {"type": "string"}},
    }
    result = {
        "type": "object",
        "additionalProperties": False,
        "properties": {"ok": {"const": True}},
    }
    files = {
        "template.json": manifest,
        "schema.json": schema,
        "result.schema.json": result,
        "fixtures/golden.json": {"note": "Hello"},
    }
    for name, content in files.items():
        path = folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(content), encoding="utf-8")
    (folder / "template.html").write_text("<p></p>", encoding="utf-8")
    (folder / "README.md").write_text("# Notiz\n", encoding="utf-8")
    return folder


def _note_registry(tmp_path):
    user = tmp_path / "user-templates"
    folder = _note_template(user)
    return scan_registry(tmp_path / "repo" / "templates", user), folder


def _note_payload(registry, avatar):
    body = {
        "schema": "report-shell/payload@1",
        "template": "child",
        "version": 1,
        "bot": "example-bot",
        "title": "Avatar",
        "created": "2026-10-08T10:39:00+02:00",
        "data": {"note": "Hello"},
        "identity": {"avatar": avatar},
    }
    return validate_payload(body, registry)


def test_template_relative_avatar_registers_from_the_pinned_directory(tmp_path):
    registry, _folder = _note_registry(tmp_path)
    store, _data_dir = _store(tmp_path, registry)
    detail = store.register(_note_payload(registry, "%RS_TEMPLATE%/face.png"))
    avatar = detail["identity"]["avatar"]
    sha = avatar.removeprefix("/avatar/")
    assert store.avatars[sha][0] == PNG_1PX


@pytest.mark.parametrize("kind", ["junction", "dir-symlink", "real-directory"])
def test_template_avatar_swap_after_schema_read_is_not_authorized(tmp_path, kind):
    registry, folder = _note_registry(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.png").write_bytes(PNG_1PX)
    store, data_dir = _store(tmp_path, registry)
    payload = _note_payload(registry, "%RS_TEMPLATE%/secret.png")
    link = None

    def swap(template):
        nonlocal link
        assert template.path == folder.resolve()
        backup = tmp_path / "original-template"
        folder.rename(backup)
        if kind == "real-directory":
            folder.mkdir()
            (folder / "secret.png").write_bytes(PNG_1PX)
            link = ("real", None)
            return
        _make_dir_link(folder, outside, kind)
        link = (folder, kind)

    store.before_media_registration = swap
    try:
        detail = store.register(payload)
    finally:
        if isinstance(link, tuple) and link[0] not in {None, "real"}:
            _remove_dir_link(folder, kind)
    assert detail["identity"]["avatar"] is None
    assert all(body != PNG_1PX for body, _content_type in store.avatars.values())
    saved = json.loads(
        (data_dir / "runs" / f"{detail['run_id']}.json").read_text(encoding="utf-8")
    )
    assert any(
        warning.get("field") == "avatar" for warning in saved["identity"]["warnings"]
    )


def test_identity_avatar_still_resolves_on_register(tmp_path):
    registry, _ = _registry(tmp_path)
    data_dir = ensure_layout(tmp_path / "data")
    avatars = data_dir / "avatars"
    avatars.mkdir()
    (avatars / "user.png").write_bytes(PNG_1PX)
    (data_dir / "bots.json").write_text(
        json.dumps({"example-bot": {"name": "Example Bot", "avatar": "avatars/user.png"}}),
        encoding="utf-8",
    )
    store = RunStore(data_dir, registry, load_config(data_dir), ActionLog(data_dir))
    detail = store.register(_payload(registry))
    avatar = detail["identity"]["avatar"]
    assert avatar.startswith("/avatar/")
    sha = avatar.removeprefix("/avatar/")
    assert store.avatars[sha][0] == PNG_1PX
    assert store.avatars[sha][1] == "image/png"


def _restart(data_dir, repo, user, config):
    fresh = scan_registry(repo / "templates", user)
    return RunStore(data_dir, fresh, config, ActionLog(data_dir))


def test_absolute_template_reload_keeps_allowlisted_media(tmp_path):
    """absolute_template_reload.py: a configured root inside the template.

    Registration of that absolute file used to store no pins. Reload then
    treated the path as forged token media and dropped it.
    """
    registry, folder = _registry(tmp_path)
    body = b"VALID_ALLOWLISTED_ABSOLUTE_MEDIA"
    image = folder / "photo-absolute.png"
    image.write_bytes(body)
    data_dir = ensure_layout(tmp_path / "data")
    config = load_config(data_dir)
    config["media_roots"] = [str(folder)]
    store = RunStore(data_dir, registry, config, ActionLog(data_dir))
    detail = store.register(_absolute_image_payload(registry, image))
    media_id = detail["data"]["image"]
    entry = store.media[media_id]
    assert entry.file_identity
    assert entry.root_identity == registry["child"].root_identity
    with open_validated_media(entry, store.media_roots(media_id)) as (handle, _):
        assert handle.read() == body

    repo = tmp_path / "repo"
    user = tmp_path / "user-templates"
    restarted = _restart(data_dir, repo, user, config)
    assert media_id in restarted.media
    with open_validated_media(
        restarted.media[media_id], restarted.media_roots(media_id)
    ) as (handle, _):
        assert handle.read() == body

    saved = data_dir / "runs" / f"{detail['run_id']}.json"
    record = json.loads(saved.read_text(encoding="utf-8"))
    item = record["media"][media_id]
    assert item["file_identity"] and item["root_identity"]
    item.pop("file_identity")
    item.pop("root_identity")
    saved.write_text(json.dumps(record), encoding="utf-8")
    forged = _restart(data_dir, repo, user, config)
    assert media_id not in forged.media


def test_absolute_media_under_nested_template_root_reloads(tmp_path):
    registry, folder = _registry(tmp_path)
    nested = folder / "shots"
    nested.mkdir()
    body = b"NESTED_ALLOWLISTED_MEDIA"
    image = nested / "absolute.png"
    image.write_bytes(body)
    data_dir = ensure_layout(tmp_path / "data")
    config = load_config(data_dir)
    config["media_roots"] = [str(nested)]
    store = RunStore(data_dir, registry, config, ActionLog(data_dir))
    detail = store.register(_absolute_image_payload(registry, image))
    media_id = detail["data"]["image"]
    assert store.media[media_id].file_identity
    assert store.media[media_id].root_identity == registry["child"].root_identity
    restarted = _restart(
        data_dir, tmp_path / "repo", tmp_path / "user-templates", config
    )
    assert media_id in restarted.media
    with open_validated_media(
        restarted.media[media_id], restarted.media_roots(media_id)
    ) as (handle, _):
        assert handle.read() == body


def test_bare_template_relative_avatar_registers_from_the_pinned_directory(tmp_path):
    registry, _folder = _note_registry(tmp_path)
    store, _data_dir = _store(tmp_path, registry)
    detail = store.register(_note_payload(registry, "face.png"))
    avatar = detail["identity"]["avatar"]
    sha = avatar.removeprefix("/avatar/")
    assert store.avatars[sha][0] == PNG_1PX


@pytest.mark.parametrize("kind", ["junction", "dir-symlink", "real-directory"])
def test_bare_avatar_schema_read_hook_does_not_read_outside(tmp_path, kind):
    """compare_bare_avatar.py: Template.read_text hook, avatar "secret.png".

    The original template holds a different valid image under that name. A
    swap that is honored would return the outside bytes. A missed hook would
    return the original bytes.
    """
    user = tmp_path / "user-templates"
    folder = _note_template(user)
    original = PNG_1PX + b"TEMPLATE"
    (folder / "secret.png").write_bytes(original)
    registry = scan_registry(tmp_path / "repo" / "templates", user)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.png").write_bytes(PNG_1PX)
    store, data_dir = _store(tmp_path, registry)
    payload = _note_payload(registry, "secret.png")
    link = None
    swapped = False
    original_read = Template.read_text

    def replacement(self, relative, *args, **kwargs):
        nonlocal link, swapped
        text = original_read(self, relative, *args, **kwargs)
        if self.id == "child" and str(relative) == "schema.json" and not swapped:
            folder.rename(tmp_path / "original-template")
            swapped = True
            if kind == "real-directory":
                folder.mkdir()
                (folder / "secret.png").write_bytes(PNG_1PX)
                return text
            _make_dir_link(folder, outside, kind)
            link = (folder, kind)
        return text

    try:
        with patch.object(Template, "read_text", replacement):
            detail = store.register(payload)
    finally:
        if link is not None:
            _remove_dir_link(folder, kind)
    assert swapped
    assert detail["identity"]["avatar"] is None
    assert all(body != PNG_1PX for body, _content_type in store.avatars.values())
    assert all(body != original for body, _content_type in store.avatars.values())
    saved = json.loads(
        (data_dir / "runs" / f"{detail['run_id']}.json").read_text(encoding="utf-8")
    )
    assert any(
        warning.get("field") == "avatar" for warning in saved["identity"]["warnings"]
    )


def _absolute_store(tmp_path, registry, root):
    data_dir = ensure_layout(tmp_path / "data")
    config = load_config(data_dir)
    config["media_roots"] = [str(root)]
    store = RunStore(data_dir, registry, config, ActionLog(data_dir))
    return store, data_dir, config


def _schema_read_swap(backup, link_path, outside, kind, swapped_flag):
    """After schema.json is read, replace link_path with a directory link."""
    original_read = Template.read_text
    link_holder = [None]

    def replacement(self, relative, *args, **kwargs):
        text = original_read(self, relative, *args, **kwargs)
        if self.id == "child" and str(relative) == "schema.json" and not swapped_flag[0]:
            link_path.rename(backup)
            swapped_flag[0] = True
            _make_dir_link(link_path, outside, kind)
            link_holder[0] = (link_path, kind)
        return text

    return replacement, link_holder


@pytest.mark.parametrize("kind", ["junction", "dir-symlink"])
def test_absolute_registration_race_does_not_serve_outside_media(tmp_path, kind):
    """absolute_registration_race.py: absolute image, root is the template.

    The supplied path lies inside the template. After schema.json is read,
    that directory becomes a link. Registration must not serve the link target.
    """
    user = tmp_path / "user-templates"
    folder = _media_template(user)
    image = folder / "secret.png"
    image.write_bytes(INSIDE)
    registry = scan_registry(tmp_path / "repo" / "templates", user)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.png").write_bytes(b"OUTSIDE_MEDIA")
    store, data_dir, _config = _absolute_store(tmp_path, registry, folder)
    payload = _absolute_image_payload(registry, image)
    swapped = [False]
    replacement, link_holder = _schema_read_swap(
        tmp_path / "original-template", folder, outside, kind, swapped
    )
    try:
        with patch.object(Template, "read_text", replacement):
            with pytest.raises(MediaError):
                store.register(payload)
    finally:
        if link_holder[0] is not None:
            _remove_dir_link(folder, kind)
    assert swapped[0]
    assert not store.media
    assert payload["run_id"] not in store.ids()
    assert not (data_dir / "runs" / f"{payload['run_id']}.json").exists()


@pytest.mark.parametrize("kind", ["junction", "dir-symlink"])
def test_nested_absolute_registration_race_does_not_serve_outside_media(tmp_path, kind):
    """nested_absolute_registration_race.py: root is a template subdirectory.

    Only that subdirectory is replaced. The template directory stays put.
    """
    user = tmp_path / "user-templates"
    folder = _media_template(user)
    shots = folder / "shots"
    shots.mkdir()
    image = shots / "secret.png"
    image.write_bytes(INSIDE)
    registry = scan_registry(tmp_path / "repo" / "templates", user)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.png").write_bytes(b"OUTSIDE_MEDIA")
    store, data_dir, _config = _absolute_store(tmp_path, registry, shots)
    payload = _absolute_image_payload(registry, image)
    swapped = [False]
    replacement, link_holder = _schema_read_swap(
        tmp_path / "original-shots", shots, outside, kind, swapped
    )
    try:
        with patch.object(Template, "read_text", replacement):
            with pytest.raises(MediaError):
                store.register(payload)
    finally:
        if link_holder[0] is not None:
            _remove_dir_link(shots, kind)
    assert swapped[0]
    assert not store.media
    assert payload["run_id"] not in store.ids()
    assert not (data_dir / "runs" / f"{payload['run_id']}.json").exists()


def test_absolute_template_path_spelling_is_classified_lexically(tmp_path):
    """A dot segment, and on Windows a different case, is still template media."""
    registry, folder = _registry(tmp_path)
    body = b"SPELLED_ABSOLUTE_MEDIA"
    image = folder / "photo-absolute.png"
    image.write_bytes(body)
    if os.name == "nt":
        spelled = str(folder).swapcase() + "\\.\\" + image.name
    else:
        spelled = str(folder) + "/./" + image.name
    store, data_dir, config = _absolute_store(tmp_path, registry, folder)
    detail = store.register(_absolute_image_payload(registry, spelled))
    media_id = detail["data"]["image"]
    entry = store.media[media_id]
    assert entry.file_identity
    assert entry.root_identity == registry["child"].root_identity
    with open_validated_media(entry, store.media_roots(media_id)) as (handle, _final):
        assert handle.read() == body
    reloaded = _restart(data_dir, tmp_path / "repo", tmp_path / "user-templates", config)
    assert media_id in reloaded.media
    with open_validated_media(
        reloaded.media[media_id], reloaded.media_roots(media_id)
    ) as (handle, _final):
        assert handle.read() == body
