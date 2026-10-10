"""The shipped built-ins decide-list, approve-one and preview-post: contract,
fixtures, expect files, string tables, README examples and neutral content."""
import json
import re
import shutil
import subprocess
import sys
import unicodedata
from pathlib import Path

import pytest

from core.check import contract_findings
from core.registry import scan_registry
from core.schema import SchemaError, validate


ROOT = Path(__file__).resolve().parents[1]
BUILTIN = ROOT / "templates" / "builtin"
IDS = ("decide-list", "approve-one", "preview-post")
FIXTURES = {
    "decide-list": {
        "valid": ("golden", "edge-single", "edge-unicode", "edge-max"),
        "invalid": {
            "invalid-six-items": "/items",
            "invalid-bad-choice": "/items/1/choices/0",
            "invalid-duplicate-ids": "/items/1/id",
        },
        "expect": ("golden", "edge-unicode", "edge-max"),
    },
    "approve-one": {
        "valid": ("golden", "edge-access", "edge-minimal", "edge-max"),
        "invalid": {"invalid-no-summary": "/summary", "invalid-check-state": "/checks/1/state"},
        "expect": ("golden", "edge-access", "edge-max"),
    },
    "preview-post": {
        "valid": ("golden", "edge-no-image", "edge-x-limit", "edge-max"),
        "invalid": {"invalid-hash-in-tag": "/hashtags/1", "invalid-no-platform": "/platforms"},
        "expect": ("golden", "edge-no-image", "edge-x-limit", "edge-max"),
    },
}
# Built-ins are product-neutral and do not carry vendor endorsements.
NON_NEUTRAL = re.compile(r"\b(?:grok|xai|official)\b", re.IGNORECASE)


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def fixture(template, name):
    return load(BUILTIN / template / "fixtures" / f"{name}.json")


def expect(template, name):
    return load(BUILTIN / template / "fixtures" / "expect" / f"{name}.json")


def schema(template, name="schema.json"):
    return load(BUILTIN / template / name)


@pytest.mark.parametrize("template", IDS)
def test_static_contract_passes(template):
    registry = scan_registry(ROOT / "templates")
    assert contract_findings(registry, ROOT, selected=[registry[template]]) == []


@pytest.mark.parametrize("template", IDS)
def test_registered_as_global_builtin_after_the_starter(template):
    registry = scan_registry(ROOT / "templates")
    entry = registry[template]
    assert (entry.source, entry.namespace, entry.extends) == ("builtin", "global", None)
    assert entry.path == BUILTIN / template
    builtins = [item.id for item in registry.values() if item.source == "builtin"]
    assert builtins[0] == "_starter"
    assert set(IDS) <= set(builtins)


@pytest.mark.parametrize("template", IDS)
def test_every_string_exists_in_english_and_german(template):
    manifest = load(BUILTIN / template / "template.json")
    tables = {lang: load(ROOT / "core" / "i18n" / f"{lang}.json") for lang in ("en", "de")}
    assert set(tables["en"]) == set(tables["de"])
    for key in manifest["strings"]:
        for lang, table in tables.items():
            assert table.get(key), f"{lang}: {key}"
            if key != "lint_em_dash":
                assert "—" not in table[key], f"{lang}: {key}"
    for key in ("choice_approve", "choice_reject", "choice_defer", "decision_pick", "send_rejection", "lint_found"):
        placeholders = {lang: sorted(re.findall(r"\{(\w+)\}", tables[lang][key])) for lang in tables}
        assert placeholders["en"] == placeholders["de"], key


@pytest.mark.parametrize("template", IDS)
def test_fixture_set_is_exactly_the_documented_list(template):
    spec = FIXTURES[template]
    names = sorted(p.stem for p in (BUILTIN / template / "fixtures").glob("*.json"))
    assert names == sorted([*spec["valid"], *spec["invalid"]])
    assert "edge-max" in spec["valid"], "calm mode needs edge-max"
    expects = sorted(p.stem for p in (BUILTIN / template / "fixtures" / "expect").glob("*.json"))
    assert expects == sorted(spec["expect"])


@pytest.mark.parametrize("template, name", [(t, n) for t in IDS for n in FIXTURES[t]["valid"]])
def test_valid_fixtures_validate(template, name):
    validate(fixture(template, name), schema(template))


@pytest.mark.parametrize("template, name, pointer", [
    (t, n, p) for t in IDS for n, p in FIXTURES[t]["invalid"].items()
])
def test_invalid_fixtures_are_rejected_with_the_pointer(template, name, pointer):
    with pytest.raises(SchemaError) as error:
        validate(fixture(template, name), schema(template))
    assert error.value.pointer == pointer


@pytest.mark.parametrize("template", IDS)
def test_golden_expect_has_flow_keyboard_and_a_valid_result(template):
    golden = expect(template, "golden")
    assert golden["flow"] and golden["keyboard"]
    assert all(set(step) <= {"press", "repeat", "type"} for step in golden["keyboard"])
    validate(golden["result"], schema(template, "result.schema.json"))


def test_decide_list_copy_ids_and_golden_shape():
    for name in FIXTURES["decide-list"]["expect"]:
        data = fixture("decide-list", name)
        ids = {
            f"item-{i}-copy-{j}": entry["text"]
            for i, item in enumerate(data["items"], 1)
            for j, entry in enumerate(item.get("copy", []), 1)
        }
        assert expect("decide-list", name)["copies"] == ids, name
    golden = fixture("decide-list", "golden")
    assert len(golden["items"]) == 5
    assert len({item["id"] for item in golden["items"]}) == 5
    assert any("choices" not in item for item in golden["items"]), "default choices are used"
    assert {tuple(item.get("choices", ())) for item in golden["items"]} >= {("approve", "reject"), ("approve", "defer")}
    result = expect("decide-list", "golden")["result"]
    assert [item["id"] for item in result["items"]] == [item["id"] for item in golden["items"]]
    for item, decided in zip(golden["items"], result["items"]):
        assert decided["choice"] in item.get("choices", ["approve", "reject", "defer"])


def test_decide_list_duplicate_ids_are_rejected_in_payload_and_result():
    data = fixture("decide-list", "invalid-duplicate-ids")
    first, second = data["items"]
    assert first["id"] == second["id"] and first["title"] != second["title"]
    with pytest.raises(SchemaError) as error:
        validate(data, schema("decide-list"), "/data")
    assert error.value.pointer == "/data/items/1/id"
    assert "already used by /data/items/0" in error.value.message
    result = {"items": [{"id": "same", "choice": "approve", "note": ""},
                        {"id": "same", "choice": "reject", "note": ""}], "note": ""}
    with pytest.raises(SchemaError) as error:
        validate(result, schema("decide-list", "result.schema.json"))
    assert error.value.pointer == "/items/1/id"


def test_check_treats_the_duplicate_id_fixture_as_invalid(tmp_path):
    """Without the unique key the fixture would pass the schema, so `check`
    reports it; with it (the shipped schema) the contract is clean."""
    tree = tmp_path / "templates" / "builtin" / "decide-list"
    shutil.copytree(BUILTIN / "decide-list", tree)
    registry = scan_registry(tmp_path / "templates")
    assert contract_findings(registry, ROOT, selected=[registry["decide-list"]]) == []
    loose = load(tree / "schema.json")
    del loose["properties"]["items"]["x-rs-unique-key"]
    (tree / "schema.json").write_text(json.dumps(loose), encoding="utf-8")
    registry = scan_registry(tmp_path / "templates")
    assert "invalid-duplicate-ids.json: expected invalid" in contract_findings(
        registry, ROOT, selected=[registry["decide-list"]]
    )


def _strings(value):
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        value = list(value.values())
    if isinstance(value, list):
        return [text for item in value for text in _strings(item)]
    return []


def test_decide_list_edges_cover_maxima_and_unicode():
    big = fixture("decide-list", "edge-max")
    assert len(big["items"]) == 5 and len(big["done"]) == 12 and len(big["intro"]) == 300
    assert max(len(c["text"]) for item in big["items"] for c in item["copy"]) == 5000
    for item in big["items"]:
        assert (len(item["kind"]), len(item["source"]), len(item["title"]), len(item["detail"])) == (24, 60, 140, 600)
        assert len(item["copy"]) == 4
    uni = "".join(_strings(fixture("decide-list", "edge-unicode")))
    for needle in ("\r\n", "\t", "‍", "🇦🇹", "東京", "한국어", "ü"):
        assert needle in uni, repr(needle)


def test_approve_one_result_schema_one_of():
    result = schema("approve-one", "result.schema.json")
    for ok in (
        {"decision": "approve", "comment": ""},
        {"decision": "reject", "comment": "Not this quarter"},
        {"decision": "request_changes", "comment": "Deploy after Friday"},
    ):
        validate(ok, result)
    for bad in (
        {"decision": "request_changes", "comment": ""},
        {"decision": "request_changes", "comment": "   "},
        {"decision": "maybe", "comment": ""},
        {"decision": "approve"},
        {"decision": "approve", "comment": "", "platforms": []},
    ):
        with pytest.raises(SchemaError):
            validate(bad, result)


def test_approve_one_copy_ids_and_fixture_roles():
    for name in FIXTURES["approve-one"]["expect"]:
        data = fixture("approve-one", name)
        ids = {f"copy-{i}": entry["text"] for i, entry in enumerate(data.get("copy", []), 1)}
        if "reference" in data:
            ids["reference"] = data["reference"]["text"]
        assert expect("approve-one", name)["copies"] == ids, name
    assert fixture("approve-one", "golden")["allow_changes"] is True
    assert "allow_changes" not in fixture("approve-one", "edge-access")
    assert set(fixture("approve-one", "edge-minimal")) == {"summary"}
    assert expect("approve-one", "golden")["result"]["decision"] == "request_changes"


def _composed(data, platform):
    text = data.get("variants", {}).get(platform, {}).get("text", data["text"])
    if data.get("hashtag_mode", "append") == "append" and data.get("hashtags"):
        text += "\n\n" + " ".join("#" + tag for tag in data["hashtags"])
    return unicodedata.normalize("NFC", text)


def test_preview_post_copies_are_the_composed_strings():
    for name in FIXTURES["preview-post"]["expect"]:
        data = fixture("preview-post", name)
        copies = expect("preview-post", name)["copies"]
        for platform in data["platforms"]:
            assert copies[f"{platform}-text"] == _composed(data, platform), (name, platform)
        assert len(copies) == len(data["platforms"]) * (1 + bool(data["hashtags"]) + bool(data.get("first_comment")))


def test_preview_post_x_limit_is_281_on_x_and_the_base_text_fits():
    data = fixture("preview-post", "edge-x-limit")
    x_text, base = _composed(data, "x"), _composed(data, "linkedin")
    assert x_text.isascii() and "://" not in x_text
    assert len(x_text) == 281
    assert len(base) <= 280
    counters = expect("preview-post", "edge-x-limit")["counters"]
    assert counters["x"] == {"count": 281, "limit": 280, "over": True}


def test_preview_post_golden_folds_on_linkedin_and_instagram_and_lints_flags():
    golden = fixture("preview-post", "golden")
    text = _composed(golden, "linkedin")
    assert len(text) > 210, "LinkedIn shows its fold label"
    assert len(_composed(golden, "instagram")) > 125, "Instagram shows its fold label"
    assert golden["image"]["ratio"] == "1.91:1" and golden["first_comment"]
    no_image = fixture("preview-post", "edge-no-image")
    assert "image" not in no_image and "instagram" in no_image["platforms"]
    found = [flag for flag in no_image["flag"] if flag in no_image["text"]]
    assert found == ["—"], "exactly one flag occurs, so one badge shows"


def test_preview_post_expect_generator_reproduces_committed_files(tmp_path):
    tree = tmp_path / "repo"
    shutil.copytree(BUILTIN / "preview-post", tree / "templates" / "builtin" / "preview-post")
    (tree / "tools" / "dev").mkdir(parents=True)
    generator = tree / "tools" / "dev" / "gen-preview-post-expect.py"
    shutil.copy(ROOT / "tools" / "dev" / "gen-preview-post-expect.py", generator)
    expect_dir = tree / "templates" / "builtin" / "preview-post" / "fixtures" / "expect"
    shutil.rmtree(expect_dir)
    expect_dir.mkdir()
    result = subprocess.run([sys.executable, str(generator)], capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr
    for path in sorted((BUILTIN / "preview-post" / "fixtures" / "expect").glob("*.json")):
        assert load(expect_dir / path.name) == load(path), path.name


def test_preview_post_fixture_media_are_template_relative_and_present():
    for name in (*FIXTURES["preview-post"]["valid"], *FIXTURES["preview-post"]["invalid"]):
        data = fixture("preview-post", name)
        paths = [data.get("image", {}).get("path"), data["author"].get("avatar")]
        for value in filter(None, paths):
            assert value.startswith("%RS_TEMPLATE%\\fixtures\\media\\"), value
            target = BUILTIN / "preview-post" / Path(*value.split("\\")[1:])
            assert target.is_file() and target.stat().st_size < 300 * 1024, value


@pytest.mark.parametrize("template", IDS)
def test_readme_examples_validate(template):
    readme = (BUILTIN / template / "README.md").read_text(encoding="utf-8")
    blocks = [json.loads(block) for block in re.findall(r"```json\n(.*?)\n```", readme, re.S)]
    assert len(blocks) >= 2
    validate(blocks[0], schema(template))
    for block in blocks[1:]:
        validate(block, schema(template, "result.schema.json"))


@pytest.mark.parametrize("template", IDS)
def test_no_private_or_branded_content(template):
    folder = BUILTIN / template
    for path in folder.rglob("*"):
        if path.is_file() and path.suffix in {".json", ".md", ".html", ".css", ".js"}:
            text = path.read_text(encoding="utf-8")
            match = NON_NEUTRAL.search(text)
            assert match is None, f"{path.relative_to(ROOT)}: {match.group(0)!r}"
    for name in ("make-builtin-media.mjs", "gen-preview-post-expect.py", "builtin-shots.mjs"):
        text = (ROOT / "tools" / "dev" / name).read_text(encoding="utf-8")
        assert NON_NEUTRAL.search(text) is None, name


@pytest.mark.parametrize("template", IDS)
def test_payload_text_reaches_the_page_only_as_text(template):
    js = (BUILTIN / template / "template.js").read_text(encoding="utf-8")
    assert "innerHTML" not in js and "insertAdjacentHTML" not in js
    assert "//" not in re.sub(r"/\*.*?\*/", "", js, flags=re.S).replace("'//'", "")
