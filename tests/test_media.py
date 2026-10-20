"""Block media: every x-rs-media field of blocks.schema.json, registered under
the configured media roots, kept across a reload, never from a template."""
import json
import os

import pytest

from core.actionlog import ActionLog
from core.envelope import validate_payload
from core.media import MediaError, open_validated_media, register_media, replace_block_media
from core.paths import ensure_layout, load_config
from core.payload import BLOCK_SCHEMAS
from core.runs import RunStore


@pytest.fixture
def media_root(tmp_path):
    root = tmp_path / "media"
    root.mkdir()
    for name in ("a.png", "poster.jpg", "avatar.webp", "clip.mp4", "clip.webm"):
        (root / name).write_bytes(b"\xff\xd8\xff media")
    (root / "notes.txt").write_text("x", encoding="utf-8")
    return root


def report(*blocks, ask="read"):
    return {
        "schema": "grokbot-desk/payload@2", "bot": "media-bot", "title": "Media",
        "created": "2026-10-18T09:00:00+02:00", "ask": ask, "blocks": list(blocks),
    }


def test_every_media_field_of_every_block_is_registered(media_root):
    post = {
        "type": "post", "author": {"name": "Shop", "handle": "shop", "avatar": str(media_root / "avatar.webp")},
        "text": "Hello.", "hashtags": [], "platforms": ["x"],
        "video": {"path": str(media_root / "clip.mp4"), "poster": str(media_root / "poster.jpg"),
                  "alt": "A clip", "ratio": "16:9"},
    }
    blocks = [
        {"type": "text", "md": "![A](a)", "images": [{"key": "a", "path": str(media_root / "a.png"), "alt": "A"}]},
        {"type": "media", "path": str(media_root / "clip.webm"), "alt": "Clip", "poster": str(media_root / "poster.jpg")},
        {"type": "media", "path": str(media_root / "a.png"), "alt": "Picture"},
        post,
    ]
    payload = validate_payload(report(*blocks, ask="approve"))
    media = {}
    out = replace_block_media(payload["blocks"], BLOCK_SCHEMAS, [media_root], media)
    ids = [
        out[0]["images"][0]["path"], out[1]["path"], out[1]["poster"], out[2]["path"],
        out[3]["author"]["avatar"], out[3]["video"]["path"], out[3]["video"]["poster"],
    ]
    assert all(value.startswith("m_") and value in media for value in ids)
    assert len(set(ids)) == 7
    assert media[out[1]["path"]].content_type == "video/webm"
    # text is never touched: a path quoted in prose stays prose
    assert out[0]["md"] == "![A](a)"


@pytest.mark.parametrize("block, message", [
    ({"type": "media", "path": "notes.txt", "alt": "x"}, "absolute"),
    ({"type": "media", "path": "{root}/notes.txt", "alt": "x"}, "extension"),
    ({"type": "text", "md": "x", "images": [{"key": "a", "path": "{root}/clip.mp4", "alt": "x"}]}, "extension"),
    ({"type": "media", "path": "%RS_TEMPLATE%/a.png", "alt": "x"}, "absolute"),
    ({"type": "media", "path": "{root}/../outside.png", "alt": "x"}, "traversal"),
    ({"type": "media", "path": "{root}/missing.png", "alt": "x"}, "does not exist"),
])
def test_block_media_follows_the_media_rules(media_root, block, message):
    block = json.loads(json.dumps(block).replace("{root}", str(media_root).replace("\\", "\\\\")))
    with pytest.raises(MediaError, match=message):
        replace_block_media([block], BLOCK_SCHEMAS, [media_root], {})


def test_media_outside_every_configured_root_is_refused(media_root, tmp_path):
    other = tmp_path / "other"
    other.mkdir()
    with pytest.raises(MediaError, match="outside configured roots"):
        register_media(str(media_root / "a.png"), [other])
    with pytest.raises(MediaError, match="outside configured roots"):
        register_media(str(media_root / "a.png"), [])


def test_block_media_survives_a_reload_and_follows_the_roots_configured_now(media_root, tmp_path):
    data_dir = ensure_layout(tmp_path / "data")
    config = dict(load_config(data_dir), media_roots=[str(media_root)])
    store = RunStore(data_dir, config, ActionLog(data_dir))
    detail = store.register(validate_payload(report({"type": "media", "path": str(media_root / "a.png"), "alt": "A"})))
    media_id = detail["blocks"][0]["path"]
    assert store.payload(detail["run_id"])["blocks"][0]["path"] == media_id

    reloaded = RunStore(data_dir, config, ActionLog(data_dir))
    assert media_id in reloaded.media
    with open_validated_media(reloaded.media[media_id], reloaded.media_roots(media_id)) as (handle, _):
        assert handle.read(3) == b"\xff\xd8\xff"
    # the root was taken out of config.json: the saved run is no allowlist
    revoked = RunStore(data_dir, dict(config, media_roots=[]), ActionLog(data_dir))
    assert media_id not in revoked.media


def test_a_pinned_template_media_record_is_not_served(media_root, tmp_path):
    """Template media of an older desk carried pins; nothing can check them now."""
    data_dir = ensure_layout(tmp_path / "data")
    config = dict(load_config(data_dir), media_roots=[str(media_root)])
    store = RunStore(data_dir, config, ActionLog(data_dir))
    detail = store.register(validate_payload(report({"type": "media", "path": str(media_root / "a.png"), "alt": "A"})))
    record_path = data_dir / "runs" / f"{detail['run_id']}.json"
    record = json.loads(record_path.read_text(encoding="utf-8"))
    media_id = detail["blocks"][0]["path"]
    record["media"][media_id]["file_identity"] = ["1", "2"]
    record["media"][media_id]["root_identity"] = ["1", "3"]
    record_path.write_text(json.dumps(record), encoding="utf-8")
    reloaded = RunStore(data_dir, config, ActionLog(data_dir))
    assert reloaded.has(detail["run_id"]) and media_id not in reloaded.media


def test_run_detail_says_which_media_is_a_video(media_root, tmp_path):
    """The page draws a media block as <img> or <video> from the detail's
    media_types (the id alone does not say)."""
    data_dir = ensure_layout(tmp_path / "data")
    config = dict(load_config(data_dir), media_roots=[str(media_root)])
    store = RunStore(data_dir, config, ActionLog(data_dir))
    detail = store.register(validate_payload(report(
        {"type": "media", "path": str(media_root / "clip.webm"), "alt": "Clip", "poster": str(media_root / "poster.jpg")},
        {"type": "media", "path": str(media_root / "a.png"), "alt": "Picture"},
    )))
    video, picture = detail["blocks"]
    assert store.detail(detail["run_id"])["media_types"] == {
        video["path"]: "video/webm", video["poster"]: "image/jpeg", picture["path"]: "image/png",
    }


@pytest.mark.skipif(os.name != "nt", reason="Windows device paths")
@pytest.mark.parametrize("prefix", [r"\\?" "\\", r"\\." "\\", "//?/"])
def test_a_drive_path_with_a_device_prefix_is_a_drive_path(media_root, prefix):
    entry = register_media(prefix + str(media_root / "a.png"), [media_root])
    assert entry.path == (media_root / "a.png").resolve()


@pytest.mark.parametrize("value", [
    r"\\server\share\a.png",
    "//server/share/a.png",
    r"\\?\UNC\server\share\a.png",
    r"\\.\UNC\server\share\a.png",
    r"\\?\Volume{00000000-0000-0000-0000-000000000000}\a.png",
    r"\\?\D:relative.png",
])
def test_network_and_volume_paths_stay_refused(media_root, value):
    with pytest.raises(MediaError, match="UNC"):
        register_media(value, [media_root])
