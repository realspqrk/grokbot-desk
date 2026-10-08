"""Template discovery and manifest validation."""
import json
import re
from dataclasses import dataclass
from pathlib import Path

from .jsonutil import loads


ID_RE = re.compile(r"^(?:_[a-z0-9][a-z0-9_-]{0,62}|[a-z0-9][a-z0-9_-]{0,63})$")
REQUIRED_FILES = ("template.json", "template.html", "schema.json", "result.schema.json", "README.md")


class RegistryError(ValueError):
    pass


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

    def summary(self):
        return {"id": self.id, "namespace": self.namespace, "version": self.version}


def _load_manifest(path):
    try:
        value = loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RegistryError(f"{path}: invalid template.json: {error}") from error
    required = {"id", "namespace", "version", "title_de", "description", "components", "strings"}
    missing = required - set(value) if isinstance(value, dict) else required
    if missing:
        raise RegistryError(f"{path}: missing manifest fields: {', '.join(sorted(missing))}")
    if set(value) - required:
        raise RegistryError(f"{path}: unknown manifest fields: {', '.join(sorted(set(value) - required))}")
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
    return value


def scan_registry(templates_root):
    root = Path(templates_root)
    templates = {}
    if not root.exists():
        return templates
    for manifest_path in sorted(root.glob("*/*/template.json")):
        folder = manifest_path.parent
        manifest = _load_manifest(manifest_path)
        namespace = folder.parent.name
        if manifest["namespace"] != namespace:
            raise RegistryError(f"{manifest_path}: namespace must match folder {namespace!r}")
        if manifest["id"] != folder.name:
            raise RegistryError(f"{manifest_path}: id must match folder {folder.name!r}")
        for filename in REQUIRED_FILES:
            if not (folder / filename).is_file():
                raise RegistryError(f"{folder}: missing required file {filename}")
        fixture_dir = folder / "fixtures"
        if not (fixture_dir / "golden.json").is_file():
            raise RegistryError(f"{folder}: missing fixtures/golden.json")
        if manifest["id"] in templates:
            raise RegistryError(f"duplicate template id: {manifest['id']}")
        templates[manifest["id"]] = Template(
            id=manifest["id"],
            namespace=manifest["namespace"],
            version=manifest["version"],
            title_de=manifest["title_de"],
            description=manifest["description"],
            components=tuple(manifest["components"]),
            strings=tuple(manifest["strings"]),
            path=folder,
        )
    return templates
