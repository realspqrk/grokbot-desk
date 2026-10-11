"""Media path allowlisting and opaque-id replacement.

%RS_TEMPLATE% media does not trust a fresh realpath of the template folder.
The registry pins that folder's identity (Windows volume serial + file index,
POSIX st_dev + st_ino) when it first resolves the template. Registration
opens the file relative to that directory with no-follow semantics and
rejects a symlink or junction on every component. Serve and reload open the
same way and require the handle's final path and file identity to match the
values stored at registration, so a directory swapped in later is not served.
Unpinned media is checked against the caller's current roots. Roots saved in
the run file are not an allowlist. A template path with no identity pin is
rejected rather than opened as ordinary media. An absolute path that a
configured root allows is pinned the same way when the supplied path lies
inside the template directory. That decision uses the lexical path, before
any link is followed, so a directory swapped for a junction cannot downgrade
the open to the ordinary reader. Reload keeps the grant and still rejects a
forged token record whose pins are missing.
"""
import mimetypes
import os
import re
import secrets
import stat
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath

from .platform import (
    PathIdentityError,
    ReparseEscape,
    final_path_for_handle,
    open_contained,
)
from .schema import SchemaError, validate


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
VIDEO_EXTENSIONS = {".mp4", ".webm"}
ALLOWED_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS
MAX_MEDIA_SIZE = 20 * 1024 * 1024
# A post video (X allows 512 MB) is served in ranges, never read whole.
MAX_VIDEO_SIZE = 200 * 1024 * 1024
# x-rs-media: true marks an image path; "video" marks a video path.
MEDIA_KINDS = {True: IMAGE_EXTENSIONS, "video": VIDEO_EXTENSIONS}
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
# A path may start with this exact token; it expands to the template's own
# folder, which is then the only media root for that path (read-only).
TEMPLATE_TOKEN = "%RS_TEMPLATE%"


class MediaError(ValueError):
    pass


@dataclass(frozen=True)
class MediaEntry:
    media_id: str
    path: Path
    content_type: str
    allowed_roots: tuple[Path, ...] = ()
    # Pinned for template media. None for ordinary media-root files.
    # Identities are (volume serial, file index) or (st_dev, st_ino).
    file_identity: tuple | None = None
    root_identity: tuple | None = None


def _contained_failure(error):
    if isinstance(error, (ReparseEscape, PathIdentityError)):
        raise MediaError("media path is outside configured roots") from error
    raise MediaError("media file is unavailable") from error


@contextmanager
def _open_pinned_media(entry):
    """Re-open template media from the root pinned at registration."""
    if not entry.allowed_roots or entry.file_identity is None:
        raise MediaError("media path is outside configured roots")
    root = entry.allowed_roots[0]
    try:
        relative = entry.path.relative_to(root)
    except ValueError as error:
        raise MediaError("media path is outside configured roots") from error
    try:
        handle, root_final, root_identity, file_identity = open_contained(
            root, relative.parts, entry.root_identity
        )
    except OSError as error:
        _contained_failure(error)
    try:
        final_path = final_path_for_handle(handle)
        if not _is_relative_to(final_path, root_final):
            raise MediaError("media path is outside configured roots")
        if file_identity != tuple(entry.file_identity):
            raise MediaError("media path is outside configured roots")
        if entry.root_identity is not None and root_identity != tuple(entry.root_identity):
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


@contextmanager
def open_validated_media(entry, roots):
    if entry.file_identity is not None:
        with _open_pinned_media(entry) as opened:
            yield opened
        return
    try:
        handle = entry.path.open("rb")
    except OSError as error:
        raise MediaError("media file is unavailable") from error
    try:
        final_path = final_path_for_handle(handle)
        # The saved entry is not an allowlist. Callers pass the roots that
        # are configured now (media_roots and registry template directories).
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


def _path_is_inside_directory(path, root):
    """True when path is lexically inside root, case-insensitively on Windows."""
    if root is None:
        return False
    path_parts = Path(path).parts
    root_parts = Path(root).parts
    if len(path_parts) <= len(root_parts):
        return False
    if os.name == "nt":
        path_parts = tuple(part.casefold() for part in path_parts)
        root_parts = tuple(part.casefold() for part in root_parts)
    return path_parts[: len(root_parts)] == root_parts


def _lexical_normalized(path):
    """Collapse "." and repeated separators without following a link."""
    return Path(os.path.normpath(os.fspath(path)))


def _relative_parts_inside(path, root):
    """Lexical components of path below root, or None when path is not inside."""
    if not _path_is_inside_directory(path, root):
        return None
    return Path(path).parts[len(Path(root).parts):]


def _path_under_configured_root(path, roots):
    """True when path is lexically inside one configured root."""
    normalized = _lexical_normalized(path)
    for root in roots:
        if _path_is_inside_directory(normalized, _lexical_normalized(root)):
            return True
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


def _template_relative_parts(value, template_root):
    if template_root is None:
        raise MediaError(f"{TEMPLATE_TOKEN} is only valid with a template")
    rest = value[len(TEMPLATE_TOKEN):]
    relative = rest[1:] if rest[:1] in ("\\", "/") else ""
    parts = tuple(re.split(r"[\\/]", relative))
    if (
        not relative
        or PureWindowsPath(relative).anchor
        or any(part in {"", ".", ".."} for part in parts)
    ):
        raise MediaError(f"{TEMPLATE_TOKEN} must be followed by a relative path")
    return parts


def _expand_template_token(value, template_root):
    parts = _template_relative_parts(value, template_root)
    return str(Path(template_root).joinpath(*parts))


def _register_contained_parts(template_root, parts, template_identity, missing_label, kind=True):
    try:
        handle, root_final, root_identity, file_identity = open_contained(
            Path(template_root), parts, template_identity
        )
    except (ReparseEscape, PathIdentityError) as error:
        raise MediaError("media path is outside configured roots") from error
    except OSError as error:
        raise MediaError(f"media file does not exist: {missing_label}") from error
    with handle:
        try:
            final_path = final_path_for_handle(handle)
            file_stat = os.fstat(handle.fileno())
        except OSError as error:
            raise MediaError("media file could not be validated") from error
        if not _is_relative_to(final_path, root_final):
            raise MediaError("media path is outside configured roots")
        if not stat.S_ISREG(file_stat.st_mode):
            raise MediaError("media path is not a regular file")
        _check_file(final_path, file_stat.st_size, kind)
    return MediaEntry(
        "m_" + secrets.token_hex(16),
        final_path,
        content_type(final_path),
        (root_final,),
        file_identity,
        root_identity,
    )


def _register_template_media(value, template_root, template_identity, kind=True):
    parts = _template_relative_parts(value, template_root)
    return _register_contained_parts(
        template_root, parts, template_identity, value, kind
    )


def register_media(value, roots, template_root=None, *, template_identity=None, kind=True):
    if not isinstance(value, str) or not value:
        raise MediaError("media path must be a non-empty string")
    if value.startswith(TEMPLATE_TOKEN):
        # template_root is the registry canonical path. It is not resolved
        # again: a junction swapped in at that path would otherwise become
        # both the file and the allowed root.
        return _register_template_media(value, template_root, template_identity, kind)
    windows = PureWindowsPath(value)
    if windows.anchor.startswith("\\\\") or value.startswith(("\\\\", "//")):
        raise MediaError("UNC media paths are forbidden")
    if ".." in windows.parts or ".." in Path(value).parts:
        raise MediaError("media traversal is forbidden")
    supplied = Path(value)
    if not supplied.is_absolute():
        raise MediaError("media path must be absolute")
    # Template origin is a property of the supplied path. resolve() follows
    # a directory swapped for a link and would hide that origin, leaving an
    # ordinary unpinned entry for the link target.
    lexical_parts = None
    if template_root is not None:
        lexical_parts = _relative_parts_inside(
            _lexical_normalized(supplied),
            _lexical_normalized(template_root),
        )
    if lexical_parts is not None:
        if not _path_under_configured_root(supplied, roots):
            _require_resolved_root(supplied, roots, value, kind)
        return _register_contained_parts(
            template_root, lexical_parts, template_identity, value, kind
        )
    resolved, allowed_roots = _require_resolved_root(supplied, roots, value, kind)
    # A path that is not lexically inside the template can still resolve
    # into it. Pin that file too: reload rejects an unpinned template path.
    # Forged token records still have no pins and stay rejected.
    if template_root is not None:
        parts = _relative_parts_inside(resolved, template_root)
        if parts is not None:
            return _register_contained_parts(
                template_root, parts, template_identity, resolved, kind
            )
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


def _replace_media(value, schemas, roots, media, template_root=None, template_identity=None):
    layers = _schema_layers(value, schemas)
    kinds = [
        schema["x-rs-media"] for schema in layers
        if schema.get("x-rs-media") is True or schema.get("x-rs-media") == "video"
    ]
    if kinds:
        entry = register_media(
            value, roots, template_root, template_identity=template_identity,
            kind=kinds[0],
        )
        media[entry.media_id] = entry
        return entry.media_id
    if isinstance(value, dict):
        return {
            key: _replace_media(
                item,
                [
                    schema["properties"][key]
                    for schema in layers
                    if key in schema.get("properties", {})
                ],
                roots,
                media,
                template_root,
                template_identity,
            )
            if any(key in schema.get("properties", {}) for schema in layers)
            else item
            for key, item in value.items()
        }
    item_schemas = [schema["items"] for schema in layers if "items" in schema]
    if isinstance(value, list) and item_schemas:
        return [
            _replace_media(item, item_schemas, roots, media, template_root, template_identity)
            for item in value
        ]
    return value


def replace_media(value, schema, roots, media, template_root=None, *, template_identity=None):
    return _replace_media(value, [schema], roots, media, template_root, template_identity)
