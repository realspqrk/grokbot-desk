import json
import os
import shutil
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path

import pytest

import core.check as check_module
from conftest import ROOT, install_minimal_template
from core.media import MediaError, TEMPLATE_TOKEN, open_validated_media, register_media
from core.paths import ensure_layout, load_config
from core.registry import RegistryError, scan_registry
from core.server import Handler, ReportHTTPServer


def _manifest(folder):
    path = folder / "template.json"
    return path, json.loads(path.read_text(encoding="utf-8"))


def _set_manifest(folder, **updates):
    path, manifest = _manifest(folder)
    manifest.update(updates)
    path.write_text(json.dumps(manifest), encoding="utf-8")


def _template_at(repo, parent, template_id, namespace="global"):
    staged = install_minimal_template(repo / "_staging", template_id)
    target = parent / template_id
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(staged, target)
    _set_manifest(target, namespace=namespace)
    return target


def _run(repo, data_dir, *args):
    return subprocess.run(
        [sys.executable, str(repo / "report_shell.py"), *args],
        cwd=repo,
        env={"RS_DATA_DIR": str(data_dir), "PYTHONDONTWRITEBYTECODE": "1"},
        capture_output=True,
        text=True,
        timeout=20,
    )


def _symlink_or_skip(target, link):
    try:
        link.symlink_to(target, target_is_directory=target.is_dir())
    except OSError as error:
        pytest.skip(f"symlink creation unavailable: {error}")


@contextmanager
def _junction_or_skip(link, target):
    if sys.platform != "win32":
        pytest.skip("junctions are Windows-specific")
    made = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True,
    )
    if made.returncode:
        detail = (made.stderr or made.stdout).decode(errors="replace")
        pytest.skip(f"junction creation unavailable: {detail}")
    try:
        yield
    finally:
        if link.exists():
            os.rmdir(link)


def test_lookup_precedence_is_user_then_builtin_then_namespace(tmp_path):
    repo = tmp_path / "repo"
    templates = repo / "templates"
    user_templates = tmp_path / "data" / "templates"
    namespace = _template_at(repo, templates / "acme", "sample", "acme")
    builtin = _template_at(repo, templates / "builtin", "sample")
    user = _template_at(repo, user_templates, "sample", "user-bot")

    registry = scan_registry(templates, user_templates)
    assert registry["sample"].path == user
    assert registry["sample"].source == "user"

    shutil.rmtree(user)
    registry = scan_registry(templates, user_templates)
    assert registry["sample"].path == builtin
    assert registry["sample"].source == "builtin"

    shutil.rmtree(builtin)
    registry = scan_registry(templates, user_templates)
    assert registry["sample"].path == namespace
    assert registry["sample"].source == "namespace"


def test_extends_builtin_uses_base_assets_and_child_contract(tmp_path):
    repo = tmp_path / "repo"
    templates = repo / "templates"
    user_templates = tmp_path / "data" / "templates"
    base = _template_at(repo, templates / "builtin", "base")
    child = _template_at(repo, user_templates, "custom", "user-bot")
    _set_manifest(child, extends="base", title_de="Custom title")
    for name in ("template.html", "template.css", "template.js"):
        (child / name).unlink()

    template = scan_registry(templates, user_templates)["custom"]

    assert template.extends == "base"
    assert template.file_path("template.html") == base / "template.html"
    assert template.file_path("template.css") == base / "template.css"
    assert template.file_path("template.js") == base / "template.js"
    assert template.file_path("schema.json") == child / "schema.json"
    assert template.file_path("fixtures/golden.json") == child / "fixtures/golden.json"


def test_extends_rejects_unknown_builtin_with_clear_check_finding(tmp_path):
    repo = tmp_path / "repo"
    templates = repo / "templates"
    user_templates = tmp_path / "data" / "templates"
    child = _template_at(repo, user_templates, "custom", "user-bot")
    _set_manifest(child, extends="missing")

    with pytest.raises(RegistryError, match="unknown built-in base 'missing'"):
        scan_registry(templates, user_templates)
    details = check_module.check_template_details("custom", repo, tmp_path / "data")
    assert details["findings"]
    assert "unknown built-in base 'missing'" in details["findings"][0]


def test_extends_rejects_builtin_cycle(tmp_path):
    repo = tmp_path / "repo"
    templates = repo / "templates"
    first = _template_at(repo, templates / "builtin", "first")
    second = _template_at(repo, templates / "builtin", "second")
    _set_manifest(first, extends="second")
    _set_manifest(second, extends="first")

    with pytest.raises(RegistryError, match="extends cycle"):
        scan_registry(templates, tmp_path / "data" / "templates")


@pytest.mark.parametrize("source", ["user", "namespace"])
def test_extends_rejects_depth_two_for_every_child_source(tmp_path, source):
    repo = tmp_path / "repo"
    templates = repo / "templates"
    base = _template_at(repo, templates / "builtin", "base")
    derived = _template_at(repo, templates / "builtin", "derived")
    _set_manifest(derived, extends="base")
    child_parent = (
        tmp_path / "data" / "templates"
        if source == "user"
        else templates / "example-bot"
    )
    child = _template_at(repo, child_parent, "child", "example-bot")
    _set_manifest(child, extends="derived")

    with pytest.raises(
        RegistryError, match="child: extends depth exceeds the limit of 1"
    ):
        scan_registry(templates, tmp_path / "data" / "templates")
    details = check_module.check_template_details(
        "child", repo, tmp_path / "data"
    )
    assert details["findings"]
    assert "child: extends depth exceeds the limit of 1" in details["findings"][0]


@pytest.mark.parametrize("base", ["../base", "builtin/base", r"..\base", "C:base"])
def test_extends_rejects_path_traversal(tmp_path, base):
    repo = tmp_path / "repo"
    templates = repo / "templates"
    child = _template_at(repo, tmp_path / "data" / "templates", "custom", "user-bot")
    _set_manifest(child, extends=base)

    with pytest.raises(RegistryError, match="extends must be a built-in template id"):
        scan_registry(templates, tmp_path / "data" / "templates")


def test_user_shadow_is_allowed_and_warned_by_check_and_doctor(tmp_path):
    repo = tmp_path / "repo"
    shutil.copytree(ROOT, repo, ignore=shutil.ignore_patterns(".git", "__pycache__"))
    data_dir = tmp_path / "data"
    user = data_dir / "templates" / "_starter"
    shutil.copytree(repo / "templates" / "builtin" / "_starter", user)
    _set_manifest(user, namespace="user-bot")

    details = check_module.check_template_details("_starter", repo, data_dir)
    assert details["findings"] == []
    assert details["warnings"] == [
        "_starter: user template shadows shipped built-in"
    ]

    doctor = _run(repo, data_dir, "doctor")
    assert doctor.returncode == 0, doctor.stderr
    assert json.loads(doctor.stdout)["warnings"] == details["warnings"]


def test_templates_json_lists_contract_and_starter_first_builtin(tmp_path):
    result = _run(ROOT, tmp_path / "data", "templates", "--json")

    assert result.returncode == 0, result.stderr
    entries = json.loads(result.stdout)
    assert entries[0] == {
        "id": "_starter",
        "source": "builtin",
        "extends": None,
        "title": "Beispielbericht",
    }
    assert all(set(item) == {"id", "source", "extends", "title"} for item in entries)


def test_new_writes_only_to_user_template_dir_and_survives_install_replacement(
    tmp_path,
):
    data_dir = tmp_path / "data"
    created = _run(ROOT, data_dir, "new", "example-bot/sample")

    assert created.returncode == 0, created.stderr
    target = data_dir / "templates" / "sample"
    assert json.loads(created.stdout)["path"] == str(target)
    assert target.is_dir()
    assert not (ROOT / "templates" / "example-bot" / "sample").exists()
    manifest = json.loads((target / "template.json").read_text(encoding="utf-8"))
    assert (manifest["id"], manifest["namespace"]) == ("sample", "example-bot")

    replacement = tmp_path / "replacement-install"
    shutil.copytree(ROOT, replacement, ignore=shutil.ignore_patterns(".git", "__pycache__"))
    listed = _run(replacement, data_dir, "templates", "--json")
    assert listed.returncode == 0, listed.stderr
    sample = next(item for item in json.loads(listed.stdout) if item["id"] == "sample")
    assert sample["source"] == "user"


def test_user_template_directory_junction_escape_is_a_check_finding(tmp_path):
    repo = tmp_path / "repo"
    templates = repo / "templates"
    user_templates = tmp_path / "data" / "templates"
    user_templates.mkdir(parents=True)
    outside = _template_at(repo, tmp_path / "outside", "escaped", "example-bot")
    junction = user_templates / "escaped"

    with _junction_or_skip(junction, outside):
        with pytest.raises(RegistryError, match="outside user template root"):
            scan_registry(templates, user_templates)
        details = check_module.check_template_details(
            "escaped", repo, tmp_path / "data"
        )
        assert details["findings"]
        assert "outside user template root" in details["findings"][0]


def test_extending_user_template_rejects_symlinked_owned_schema(tmp_path):
    repo = tmp_path / "repo"
    templates = repo / "templates"
    user_templates = tmp_path / "data" / "templates"
    _template_at(repo, templates / "builtin", "base")
    child = _template_at(repo, user_templates, "child", "example-bot")
    _set_manifest(child, extends="base")
    for name in ("template.html", "template.css", "template.js"):
        (child / name).unlink()
    outside = tmp_path / "outside-schema.json"
    outside.write_text('{"type":"object"}', encoding="utf-8")
    schema = child / "schema.json"
    schema.unlink()
    _symlink_or_skip(outside, schema)
    try:
        with pytest.raises(RegistryError, match="outside template directory"):
            scan_registry(templates, user_templates)
        details = check_module.check_template_details(
            "child", repo, tmp_path / "data"
        )
        assert details["findings"]
        assert "outside template directory" in details["findings"][0]
    finally:
        schema.unlink(missing_ok=True)


def test_server_rejects_user_html_replaced_by_outside_symlink_after_scan(
    tmp_path,
):
    repo = tmp_path / "repo"
    templates = repo / "templates"
    user_templates = tmp_path / "data" / "templates"
    child = _template_at(repo, user_templates, "child", "example-bot")
    registry = scan_registry(templates, user_templates)
    outside = tmp_path / "outside.html"
    sentinel = "OUTSIDE_PRIVATE_TEMPLATE_HTML"
    outside.write_text(f"<p>{sentinel}</p>", encoding="utf-8")
    html = child / "template.html"
    html.unlink()
    _symlink_or_skip(outside, html)
    server = None
    try:
        with pytest.raises(RegistryError, match="outside template directory"):
            server = ReportHTTPServer(
                ("127.0.0.1", 0),
                Handler,
                ensure_layout(tmp_path / "server-data"),
                registry,
                load_config(tmp_path / "server-data"),
            )
    finally:
        if server is not None:
            server.server_close()
        html.unlink(missing_ok=True)


def test_template_media_root_replacement_is_not_served(tmp_path):
    repo = tmp_path / "repo"
    templates = repo / "templates"
    user_templates = tmp_path / "data" / "templates"
    child = _template_at(repo, user_templates, "child", "example-bot")
    inside_media = child / "image.png"
    inside_media.write_bytes(b"ALLOWED")
    template = scan_registry(templates, user_templates)["child"]
    entry = register_media(
        TEMPLATE_TOKEN + r"\image.png",
        [],
        template_root=template.path,
    )
    moved = tmp_path / "original-child"
    outside = tmp_path / "outside-child"
    outside.mkdir()
    (outside / "image.png").write_bytes(b"OUTSIDE_PRIVATE_MEDIA")
    child.rename(moved)

    with _junction_or_skip(child, outside):
        with pytest.raises(MediaError, match="outside configured roots"):
            with open_validated_media(entry, [template.path]):
                pass


def test_new_rejects_templates_root_junction_outside_data_dir(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    templates_link = data_dir / "templates"

    with _junction_or_skip(templates_link, outside):
        created = _run(ROOT, data_dir, "new", "example-bot/escaped")
        assert created.returncode == 7
        assert "outside data directory" in created.stderr
        assert not (outside / "escaped").exists()


def test_score_and_javascript_tools_use_shared_registry_lookup():
    score = (ROOT / "tools" / "score.py").read_text(encoding="utf-8")
    assert "scan_registry(" in score
    assert 'glob("*/*/template.json")' not in score

    for name in ("e2e.mjs", "visual.mjs", "counter_test.mjs"):
        source = (ROOT / "tools" / name).read_text(encoding="utf-8")
        assert "template-registry.mjs" in source
        assert "resolvedTemplates(" in source
    server = (ROOT / "tools" / "dev" / "rs-server.mjs").read_text(
        encoding="utf-8"
    )
    assert "copyUserTemplates" in server
