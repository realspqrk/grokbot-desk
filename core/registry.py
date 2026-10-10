"""Template discovery, precedence, inheritance, and manifest validation."""
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path

from .jsonutil import loads
from .platform import directory_identity, final_path_for_handle


ID_RE = re.compile(r"^(?:_[a-z0-9][a-z0-9_-]{0,62}|[a-z0-9][a-z0-9_-]{0,63})$")
REQUIRED_FILES = ("template.json", "template.html", "schema.json", "result.schema.json", "README.md")
EXTENDING_REQUIRED_FILES = ("template.json", "schema.json", "result.schema.json", "README.md")
INHERITED_ASSETS = frozenset(("template.html", "template.css", "template.js"))


class RegistryError(ValueError):
    pass


def _is_relative_to(path, root):
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _safe_relative(relative):
    relative = Path(relative)
    if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
        raise RegistryError(f"invalid template-relative path: {relative}")
    return relative


def _read_contained_bytes(path, permitted_root):
    path = Path(path)
    try:
        handle = path.open("rb")
    except OSError as error:
        raise RegistryError(f"{path}: template file is unavailable: {error}") from error
    with handle:
        try:
            final_path = final_path_for_handle(handle)
            if not _is_relative_to(final_path, permitted_root):
                raise RegistryError(
                    f"{path}: template file is outside template directory"
                )
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                raise RegistryError(f"{path}: template path is not a regular file")
            return handle.read()
        except RegistryError:
            raise
        except OSError as error:
            raise RegistryError(
                f"{path}: template file could not be validated: {error}"
            ) from error


def _validate_contained_file(path, permitted_root):
    _read_contained_bytes(path, permitted_root)


class Registry(dict):
    def __init__(
        self,
        *args,
        warnings=(),
        templates_root=None,
        user_templates_root=None,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self.warnings = tuple(warnings)
        self.templates_root = Path(templates_root) if templates_root is not None else None
        self.user_templates_root = (
            Path(user_templates_root)
            if user_templates_root is not None
            else None
        )


@dataclass(frozen=True)
class Template:
    id: str
    namespace: str
    version: int
    title_de: str
    description: str
    components: tuple
    strings: tuple
    path: Path
    source: str = "namespace"
    extends: str | None = None
    base_path: Path | None = None
    # (volume serial, file index) on Windows, (st_dev, st_ino) on POSIX.
    # Captured when this canonical directory was established. Media registration
    # refuses the path if a later open does not see the same directory.
    root_identity: tuple | None = None

    def summary(self):
        return {"id": self.id, "namespace": self.namespace, "version": self.version}

    def listing(self, include_path=False):
        value = {
            "id": self.id,
            "source": self.source,
            "extends": self.extends,
            "title": self.title_de,
        }
        if include_path:
            value["path"] = str(self.path)
        return value

    def file_path(self, relative):
        relative = _safe_relative(relative)
        if (
            self.base_path is not None
            and len(relative.parts) == 1
            and relative.name in INHERITED_ASSETS
        ):
            root = self.base_path
        else:
            root = self.path
        candidate = root / relative
        if candidate.exists():
            try:
                resolved = candidate.resolve(strict=True)
            except OSError as error:
                raise RegistryError(
                    f"{candidate}: template file could not be resolved"
                ) from error
            if not _is_relative_to(resolved, root):
                raise RegistryError(
                    f"{candidate}: template file is outside template directory"
                )
        return candidate

    def read_bytes(self, relative):
        relative = _safe_relative(relative)
        if (
            self.base_path is not None
            and len(relative.parts) == 1
            and relative.name in INHERITED_ASSETS
        ):
            root = self.base_path
        else:
            root = self.path
        return _read_contained_bytes(root / relative, root)

    def read_text(self, relative, encoding="utf-8"):
        try:
            return self.read_bytes(relative).decode(encoding)
        except UnicodeDecodeError as error:
            raise RegistryError(
                f"{self.file_path(relative)}: template file is not valid {encoding}"
            ) from error

    def read_optional_text(self, relative, encoding="utf-8"):
        path = self.file_path(relative)
        if not path.exists():
            return None
        return self.read_text(relative, encoding=encoding)

    def glob_files(self, relative, pattern):
        relative = _safe_relative(relative)
        folder = self.path / relative
        try:
            resolved_folder = folder.resolve(strict=True)
        except FileNotFoundError:
            return []
        except OSError as error:
            raise RegistryError(
                f"{folder}: template directory could not be resolved"
            ) from error
        if not _is_relative_to(resolved_folder, self.path):
            raise RegistryError(
                f"{folder}: template directory is outside template directory"
            )
        result = []
        for path in sorted(folder.glob(pattern)):
            item = path.relative_to(self.path)
            _validate_contained_file(path, self.path)
            result.append(item)
        return result


def _load_manifest(path, permitted_root):
    try:
        value = loads(_read_contained_bytes(path, permitted_root).decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise RegistryError(f"{path}: invalid template.json: {error}") from error
    required = {"id", "namespace", "version", "title_de", "description", "components", "strings"}
    allowed = required | {"extends"}
    missing = required - set(value) if isinstance(value, dict) else required
    if missing:
        raise RegistryError(f"{path}: missing manifest fields: {', '.join(sorted(missing))}")
    if set(value) - allowed:
        raise RegistryError(f"{path}: unknown manifest fields: {', '.join(sorted(set(value) - allowed))}")
    if not isinstance(value["id"], str) or not ID_RE.fullmatch(value["id"]):
        raise RegistryError(f"{path}: invalid template id")
    if not isinstance(value["namespace"], str) or not ID_RE.fullmatch(value["namespace"]):
        raise RegistryError(f"{path}: invalid namespace")
    if not isinstance(value["version"], int) or isinstance(value["version"], bool) or value["version"] < 1:
        raise RegistryError(f"{path}: version must be a positive integer")
    if not isinstance(value["title_de"], str) or not value["title_de"]:
        raise RegistryError(f"{path}: title_de must be a non-empty string")
    if not isinstance(value["description"], str):
        raise RegistryError(f"{path}: description must be a string")
    if (
        not isinstance(value["components"], list)
        or not all(isinstance(item, str) for item in value["components"])
        or not isinstance(value["strings"], list)
        or not all(isinstance(item, str) for item in value["strings"])
    ):
        raise RegistryError(f"{path}: components and strings must be arrays")
    if "extends" in value and (
        not isinstance(value["extends"], str)
        or not ID_RE.fullmatch(value["extends"])
    ):
        raise RegistryError(f"{path}: extends must be a built-in template id")
    return value


def _candidate(manifest_path, source, source_root):
    discovered_folder = manifest_path.parent
    try:
        folder = discovered_folder.resolve(strict=True)
    except OSError as error:
        raise RegistryError(
            f"{discovered_folder}: template directory could not be resolved"
        ) from error
    if not _is_relative_to(folder, source_root):
        raise RegistryError(
            f"{discovered_folder}: outside {source} template root"
        )
    manifest = _load_manifest(manifest_path, folder)
    if manifest["id"] != discovered_folder.name:
        raise RegistryError(
            f"{manifest_path}: id must match folder {discovered_folder.name!r}"
        )
    if (
        source == "namespace"
        and manifest["namespace"] != discovered_folder.parent.name
    ):
        raise RegistryError(
            f"{manifest_path}: namespace must match folder "
            f"{discovered_folder.parent.name!r}"
        )
    required_files = (
        EXTENDING_REQUIRED_FILES if manifest.get("extends") else REQUIRED_FILES
    )
    for filename in required_files:
        path = folder / filename
        if not path.is_file():
            raise RegistryError(f"{folder}: missing required file {filename}")
        _validate_contained_file(path, folder)
    fixture_dir = folder / "fixtures"
    if not (fixture_dir / "golden.json").is_file():
        raise RegistryError(f"{folder}: missing fixtures/golden.json")
    _validate_contained_file(fixture_dir / "golden.json", folder)
    return manifest, folder


def _source_candidates(root, user_root):
    groups = {"user": [], "builtin": [], "namespace": []}
    if user_root is not None and user_root.exists():
        canonical_user_root = user_root.resolve(strict=True)
        groups["user"] = [
            (path, "user", canonical_user_root)
            for path in sorted(user_root.glob("*/template.json"))
        ]
    builtin_root = root / "builtin"
    if builtin_root.exists():
        canonical_root = root.resolve(strict=True)
        canonical_builtin_root = builtin_root.resolve(strict=True)
        if not _is_relative_to(canonical_builtin_root, canonical_root):
            raise RegistryError(
                f"{builtin_root}: outside builtin template root"
            )
        groups["builtin"] = [
            (path, "builtin", canonical_builtin_root)
            for path in sorted(
                builtin_root.glob("*/template.json"),
                key=lambda item: (item.parent.name != "_starter", item.parent.name),
            )
        ]
    if root.exists():
        canonical_root = root.resolve(strict=True)
        groups["namespace"] = [
            (path, "namespace", canonical_root)
            for path in sorted(root.glob("*/*/template.json"))
            if path.parent.parent.name != "builtin"
        ]
    return groups


def _validate_builtin_inheritance(candidates):
    manifests = {
        manifest["id"]: (manifest, folder)
        for manifest, folder, source in candidates
        if source == "builtin"
    }

    def visit(template_id, chain):
        if template_id in chain:
            cycle = " -> ".join((*chain, template_id))
            raise RegistryError(f"extends cycle: {cycle}")
        manifest, _ = manifests[template_id]
        base_id = manifest.get("extends")
        if base_id is None:
            return
        if base_id not in manifests:
            raise RegistryError(
                f"{template_id}: unknown built-in base {base_id!r}"
            )
        visit(base_id, (*chain, template_id))

    for template_id in manifests:
        visit(template_id, ())
    for template_id, (manifest, _) in manifests.items():
        base_id = manifest.get("extends")
        if base_id is not None and manifests[base_id][0].get("extends") is not None:
            raise RegistryError(
                f"{template_id}: extends depth exceeds the limit of 1"
            )
    return manifests


def scan_registry(templates_root, user_templates_root=None):
    root = Path(templates_root)
    user_root = (
        Path(user_templates_root) if user_templates_root is not None else None
    )
    groups = _source_candidates(root, user_root)
    candidates = []
    for source in ("user", "builtin", "namespace"):
        seen = set()
        for manifest_path, _, source_root in groups[source]:
            manifest, folder = _candidate(manifest_path, source, source_root)
            if manifest["id"] in seen:
                raise RegistryError(
                    f"duplicate {source} template id: {manifest['id']}"
                )
            seen.add(manifest["id"])
            candidates.append((manifest, folder, source))
    builtins = _validate_builtin_inheritance(candidates)
    for manifest, _, _ in candidates:
        base_id = manifest.get("extends")
        if base_id is not None and base_id not in builtins:
            raise RegistryError(
                f"{manifest['id']}: unknown built-in base {base_id!r}"
            )
        if (
            base_id is not None
            and builtins[base_id][0].get("extends") is not None
        ):
            raise RegistryError(
                f"{manifest['id']}: extends depth exceeds the limit of 1"
            )

    templates = Registry(
        templates_root=root, user_templates_root=user_root
    )
    warnings = []
    for manifest, folder, source in candidates:
        template_id = manifest["id"]
        if template_id in templates:
            continue
        base_id = manifest.get("extends")
        base_path = builtins[base_id][1] if base_id is not None else None
        try:
            root_identity = directory_identity(folder)
        except OSError as error:
            raise RegistryError(
                f"{folder}: template directory could not be identified"
            ) from error
        templates[template_id] = Template(
            id=manifest["id"],
            namespace=manifest["namespace"],
            version=manifest["version"],
            title_de=manifest["title_de"],
            description=manifest["description"],
            components=tuple(manifest["components"]),
            strings=tuple(manifest["strings"]),
            path=folder,
            source=source,
            extends=base_id,
            base_path=base_path,
            root_identity=root_identity,
        )
        if source == "user" and template_id in builtins:
            warnings.append(
                f"{template_id}: user template shadows shipped built-in"
            )
    templates.warnings = tuple(warnings)
    return templates
