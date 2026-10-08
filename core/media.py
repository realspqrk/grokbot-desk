"""Media path allowlisting and opaque-id replacement."""
import mimetypes
import os
import secrets
import stat
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath

from .schema import SchemaError, validate


ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
MAX_MEDIA_SIZE = 20 * 1024 * 1024
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


def _final_path_for_handle(handle):
    if os.name != "nt":
        descriptor_path = Path(f"/proc/self/fd/{handle.fileno()}")
        return descriptor_path.resolve(strict=True) if descriptor_path.exists() else Path(handle.name).resolve(strict=True)
    import ctypes
    import msvcrt
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    get_final_path = kernel32.GetFinalPathNameByHandleW
    get_final_path.argtypes = [
        wintypes.HANDLE,
        wintypes.LPWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
    ]
    get_final_path.restype = wintypes.DWORD
    os_handle = msvcrt.get_osfhandle(handle.fileno())
    size = get_final_path(os_handle, None, 0, 0)
    if not size:
        raise ctypes.WinError(ctypes.get_last_error())
    buffer = ctypes.create_unicode_buffer(size + 1)
    written = get_final_path(os_handle, buffer, len(buffer), 0)
    if not written or written >= len(buffer):
        raise ctypes.WinError(ctypes.get_last_error())
    value = buffer.value
    if value.startswith("\\\\?\\UNC\\"):
        value = "\\\\" + value[8:]
    elif value.startswith("\\\\?\\"):
        value = value[4:]
    return Path(value)


@contextmanager
def open_validated_media(entry, roots):
    try:
        handle = entry.path.open("rb")
    except OSError as error:
        raise MediaError("media file is unavailable") from error
    try:
        final_path = _final_path_for_handle(handle)
        allowed_roots = []
        for root in roots:
            try:
                allowed_roots.append(Path(root).resolve(strict=True))
            except OSError:
                continue
        if not any(_is_relative_to(final_path, root) for root in allowed_roots):
            raise MediaError("media path is outside configured roots")
        if final_path.suffix.lower() not in ALLOWED_EXTENSIONS:
            raise MediaError("media extension is not allowed")
        file_stat = os.fstat(handle.fileno())
        if not stat.S_ISREG(file_stat.st_mode):
            raise MediaError("media path is not a regular file")
        if file_stat.st_size > MAX_MEDIA_SIZE:
            raise MediaError("media file exceeds 20 MB")
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


def _expand_template_token(value, template_root):
    if template_root is None:
        raise MediaError(f"{TEMPLATE_TOKEN} is only valid with a template")
    rest = value[len(TEMPLATE_TOKEN):]
    relative = rest.lstrip("\\/")
    if rest[:1] not in ("\\", "/") or not relative or PureWindowsPath(relative).anchor:
        raise MediaError(f"{TEMPLATE_TOKEN} must be followed by a relative path")
    return str(Path(template_root)) + "\\" + relative


def register_media(value, roots, template_root=None):
    if not isinstance(value, str) or not value:
        raise MediaError("media path must be a non-empty string")
    if value.startswith(TEMPLATE_TOKEN):
        value = _expand_template_token(value, template_root)
        roots = [template_root]
    windows = PureWindowsPath(value)
    if windows.anchor.startswith("\\\\") or value.startswith(("\\\\", "//")):
        raise MediaError("UNC media paths are forbidden")
    if ".." in windows.parts or ".." in Path(value).parts:
        raise MediaError("media traversal is forbidden")
    supplied = Path(value)
    if not supplied.is_absolute():
        raise MediaError("media path must be absolute")
    try:
        resolved = supplied.resolve(strict=True)
    except OSError as error:
        raise MediaError(f"media file does not exist: {value}") from error
    allowed_roots = []
    for root in roots:
        try:
            allowed_roots.append(Path(root).resolve(strict=True))
        except OSError:
            continue
    if not any(_is_relative_to(resolved, root) for root in allowed_roots):
        raise MediaError("media path is outside configured roots")
    if resolved.suffix.lower() not in ALLOWED_EXTENSIONS:
        raise MediaError("media extension is not allowed")
    if resolved.stat().st_size > MAX_MEDIA_SIZE:
        raise MediaError("media file exceeds 20 MB")
    return MediaEntry(
        "m_" + secrets.token_hex(16),
        resolved,
        mimetypes.guess_type(resolved.name)[0] or "application/octet-stream",
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


def _replace_media(value, schemas, roots, media, template_root=None):
    layers = _schema_layers(value, schemas)
    if any(schema.get("x-rs-media") is True for schema in layers):
        entry = register_media(value, roots, template_root)
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
            )
            if any(key in schema.get("properties", {}) for schema in layers)
            else item
            for key, item in value.items()
        }
    item_schemas = [schema["items"] for schema in layers if "items" in schema]
    if isinstance(value, list) and item_schemas:
        return [_replace_media(item, item_schemas, roots, media, template_root) for item in value]
    return value


def replace_media(value, schema, roots, media, template_root=None):
    return _replace_media(value, [schema], roots, media, template_root)
