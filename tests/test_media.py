"""Template-relative media token containment and persistence."""
import json
import os
import subprocess

import pytest

from conftest import ROOT
from core.actionlog import ActionLog
from core.envelope import validate_payload
from core.media import (
    TEMPLATE_TOKEN,
    MediaError,
    open_validated_media,
    register_media,
    replace_media,
)
from core.paths import ensure_layout, load_config
from core.registry import scan_registry
from core.runs import RunStore


PREVIEW_TEMPLATE = ROOT / "templates" / "builtin" / "preview-post"
PREVIEW_FIXTURE = PREVIEW_TEMPLATE / "fixtures" / "golden.json"


@pytest.fixture
def template_dir(tmp_path):
    folder = tmp_path / "template"
    (folder / "fixtures" / "media").mkdir(parents=True)
    (folder / "fixtures" / "media" / "a.png").write_bytes(b"png")
    (folder / "fixtures" / "media" / "notes.txt").write_text(
        "x", encoding="utf-8"
    )
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "b.png").write_bytes(b"png")
    return folder


def test_token_expands_to_the_template_folder(template_dir):
    for value in (
        TEMPLATE_TOKEN + "\\fixtures\\media\\a.png",
        TEMPLATE_TOKEN + "/fixtures/media/a.png",
    ):
        entry = register_media(value, [], template_root=template_dir)
        assert entry.path == (
            template_dir / "fixtures" / "media" / "a.png"
        ).resolve()
        assert entry.media_id.startswith("m_") and len(entry.media_id) == 34
        assert entry.content_type == "image/png"


def test_token_needs_a_template_and_the_exact_spelling(template_dir):
    with pytest.raises(MediaError):
        register_media(
            TEMPLATE_TOKEN + "\\fixtures\\media\\a.png",
            [template_dir],
        )
    for value in (
        "%rs_template%\\fixtures\\media\\a.png",
        "%RS_TEMPLATE\\fixtures\\media\\a.png",
        "x" + TEMPLATE_TOKEN + "\\fixtures\\media\\a.png",
    ):
        with pytest.raises(MediaError):
            register_media(value, [], template_root=template_dir)


@pytest.mark.parametrize(
    "rest",
    [
        "",
        "\\",
        "fixtures\\media\\a.png",
        "\\..\\outside\\b.png",
        "\\fixtures\\..\\..\\outside\\b.png",
        "/../outside/b.png",
        "\\C:\\Windows\\win.ini",
        "\\C:fixtures\\media\\a.png",
        "\\\\server\\share\\a.png",
        "\\fixtures\\media\\notes.txt",
        "\\fixtures\\media\\missing.png",
    ],
)
def test_token_escape_attempts_are_rejected(template_dir, rest):
    with pytest.raises(MediaError):
        register_media(
            TEMPLATE_TOKEN + rest,
            [template_dir.parent],
            template_root=template_dir,
        )


def test_token_root_is_only_for_token_paths(template_dir, tmp_path):
    with pytest.raises(MediaError):
        register_media(
            str(template_dir / "fixtures" / "media" / "a.png"),
            [],
            template_root=template_dir,
        )
    with pytest.raises(MediaError):
        register_media(
            TEMPLATE_TOKEN + "\\..\\outside\\b.png",
            [tmp_path / "outside"],
            template_root=template_dir,
        )


def test_token_keeps_size_limit(template_dir):
    huge = template_dir / "fixtures" / "media" / "huge.png"
    with huge.open("wb") as handle:
        handle.truncate(20 * 1024 * 1024 + 1)
    with pytest.raises(MediaError):
        register_media(
            TEMPLATE_TOKEN + "\\fixtures\\media\\huge.png",
            [],
            template_root=template_dir,
        )


@pytest.mark.skipif(os.name != "nt", reason="junctions are Windows-specific")
def test_token_rejects_junction_out_of_the_template(template_dir, tmp_path):
    junction = template_dir / "fixtures" / "jump"
    made = subprocess.run(
        [
            "cmd",
            "/c",
            "mklink",
            "/J",
            str(junction),
            str(tmp_path / "outside"),
        ],
        capture_output=True,
    )
    if made.returncode:
        pytest.skip("junction creation unavailable")
    with pytest.raises(MediaError):
        register_media(
            TEMPLATE_TOKEN + "\\fixtures\\jump\\b.png",
            [tmp_path],
            template_root=template_dir,
        )


def test_replace_media_passes_the_template_root(template_dir):
    schema = {
        "type": "object",
        "properties": {
            "image": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "x-rs-media": True}
                },
            }
        },
    }
    media = {}
    out = replace_media(
        {
            "image": {
                "path": TEMPLATE_TOKEN + "\\fixtures\\media\\a.png"
            }
        },
        schema,
        [],
        media,
        template_root=template_dir,
    )
    assert out["image"]["path"] in media


def test_template_media_survives_run_store_reload(tmp_path):
    data_dir = ensure_layout(tmp_path / "data")
    registry = scan_registry(ROOT / "templates")
    payload = validate_payload(
        {
            "schema": "report-shell/payload@1",
            "template": "preview-post",
            "version": 1,
            "bot": "research-agent",
            "title": "Preview",
            "created": "2026-10-08T10:39:00+02:00",
            "data": json.loads(
                PREVIEW_FIXTURE.read_text(encoding="utf-8")
            ),
        },
        registry,
    )
    config = load_config(data_dir)
    store = RunStore(data_dir, registry, config, ActionLog(data_dir))
    detail = store.register(payload)
    media_id = detail["data"]["image"]["path"]

    reloaded = RunStore(data_dir, registry, config, ActionLog(data_dir))

    assert media_id in reloaded.media
    with open_validated_media(
        reloaded.media[media_id], reloaded.media_roots(media_id)
    ) as (handle, _):
        assert handle.read(3) == b"\xff\xd8\xff"
