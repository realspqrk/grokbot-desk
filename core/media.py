"""Media path allowlisting and opaque-id replacement.

A report names media by absolute path (fields marked x-rs-media in
blocks.schema.json). Registration resolves the path and requires it inside a
configured media root; the page only ever sees an opaque media id. Serve and
reload open the saved path again and check the handle's final path against
the roots configured now: roots saved in the run file are not an allowlist.
"""
import mimetypes
import os
import secrets
import stat
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath

from .platform import final_path_for_handle
from .schema import SchemaError, validate


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
VIDEO_EXTENSIONS = {".mp4", ".webm"}
ALLOWED_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS
MAX_MEDIA_SIZE = 20 * 1024 * 1024
# A post video (X allows 512 MB) is served in ranges, never read whole.
MAX_VIDEO_SIZE = 200 * 1024 * 1024
# x-rs-media: true marks an image path; "video" marks a video path; "any"
# takes either (the media block).
MEDIA_KINDS = {True: IMAGE_EXTENSIONS, "video": VIDEO_EXTENSIONS, "any": ALLOWED_EXTENSIONS}
CONTENT_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".gif": "image/gif",
    ".mp4": "video/mp4", ".webm": "video/webm",
}


def max_size(path):
    return MAX_VIDEO_SIZE if Path(path).suffix.lower() in VIDEO_EXTENSIONS else MAX_MEDIA_SIZE


def _check_file(path, size, kind=None):
    """Extension (of the kind, when given) and the size limit for it."""
    suffix = Path(path).suffix.lower()
    allowed = MEDIA_KINDS.get(kind, ALLOWED_EXTENSIONS) if kind is not None else ALLOWED_EXTENSIONS
    if suffix not in allowed:
        raise MediaError("media extension is not allowed")
    if size > max_size(path):
        raise MediaError(
            "media file exceeds 200 MB" if suffix in VIDEO_EXTENSIONS else "media file exceeds 20 MB"
        )


def content_type(path):
    return CONTENT_TYPES.get(Path(path).suffix.lower()) or (
        mimetypes.guess_type(Path(path).name)[0] or "application/octet-stream"
    )


class MediaError(ValueError):
    pass


@dataclass(frozen=True)
class MediaEntry:
    media_id: str
    path: Path
    content_type: str
    allowed_roots: tuple[Path, ...] = ()


@contextmanager
def open_validated_media(entry, roots):
    try:
        handle = entry.path.open("rb")
    except OSError as error:
        raise MediaError("media file is unavailable") from error
    try:
        final_path = final_path_for_handle(handle)
        # The saved entry is not an allowlist. Callers pass the roots that
        # are configured now (config media_roots).
        allowed_roots = []
        for root in roots:
            try:
                allowed_roots.append(Path(root).resolve(strict=True))
            except OSError:
                continue
        if not any(_is_relative_to(final_path, root) for root in allowed_roots):
            raise MediaError("media path is outside configured roots")
        file_stat = os.fstat(handle.fileno())
        if not stat.S_ISREG(file_stat.st_mode):
            raise MediaError("media path is not a regular file")
        _check_file(final_path, file_stat.st_size)
        yield handle, final_path
    except OSError as error:
        raise MediaError("media file could not be validated") from error
    finally:
        handle.close()


def _is_relative_to(path, root):
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _require_resolved_root(supplied, roots, label, kind=True):
    """Authorize supplied against roots after a link-following resolve.

    Returns (resolved path, resolved roots). Missing files and paths outside
    every configured root raise MediaError.
    """
    try:
        resolved = Path(supplied).resolve(strict=True)
    except OSError as error:
        raise MediaError(f"media file does not exist: {label}") from error
    allowed_roots = []
    for root in roots:
        try:
            allowed_roots.append(Path(root).resolve(strict=True))
        except OSError:
            continue
    if not any(_is_relative_to(resolved, root) for root in allowed_roots):
        raise MediaError("media path is outside configured roots")
    _check_file(resolved, resolved.stat().st_size, kind)
    return resolved, allowed_roots


def register_media(value, roots, *, kind=True):
    if not isinstance(value, str) or not value:
        raise MediaError("media path must be a non-empty string")
    windows = PureWindowsPath(value)
    if windows.anchor.startswith("\\\\") or value.startswith(("\\\\", "//")):
        raise MediaError("UNC media paths are forbidden")
    if ".." in windows.parts or ".." in Path(value).parts:
        raise MediaError("media traversal is forbidden")
    supplied = Path(value)
    if not supplied.is_absolute():
        raise MediaError("media path must be absolute")
    resolved, allowed_roots = _require_resolved_root(supplied, roots, value, kind)
    return MediaEntry(
        "m_" + secrets.token_hex(16),
        resolved,
        content_type(resolved),
        tuple(allowed_roots),
    )


def _schema_layers(value, schemas):
    layers = []
    for schema in schemas:
        layers.append(schema)
        for option in schema.get("oneOf", []):
            try:
                validate(value, option)
            except SchemaError:
                continue
            layers.extend(_schema_layers(value, [option]))
    return layers


def _replace_media(value, schemas, roots, media):
    layers = _schema_layers(value, schemas)
    kinds = [
        schema["x-rs-media"] for schema in layers
        if schema.get("x-rs-media") is True or schema.get("x-rs-media") in ("video", "any")
    ]
    if kinds:
        entry = register_media(value, roots, kind=kinds[0])
        media[entry.media_id] = entry
        return entry.media_id
    if isinstance(value, dict):
        return {
            key: _replace_media(
                item,
                [schema["properties"][key] for schema in layers if key in schema.get("properties", {})],
                roots,
                media,
            )
            if any(key in schema.get("properties", {}) for schema in layers)
            else item
            for key, item in value.items()
        }
    item_schemas = [schema["items"] for schema in layers if "items" in schema]
    if isinstance(value, list) and item_schemas:
        return [_replace_media(item, item_schemas, roots, media) for item in value]
    return value


def replace_media(value, schema, roots, media):
    """value with every x-rs-media path replaced by a registered media id
    (added to `media`). Raises MediaError."""
    return _replace_media(value, [schema], roots, media)


def replace_block_media(blocks, schemas, roots, media):
    """Each block with its media replaced, checked against its type's schema."""
    return [replace_media(block, schemas[block["type"]], roots, media) for block in blocks]
