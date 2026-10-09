import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

import core.check as check_module
from conftest import free_port, install_minimal_template
from core.check import check_template
from core.lint import _forbidden_js_apis, _js_tokens
from core.paths import ensure_layout, load_config
from core.registry import RegistryError, scan_registry
from core.server import Handler, ReportHTTPServer


ROOT = Path(__file__).resolve().parents[1]
P6_RUNNER = ROOT / "tools" / "e2e.mjs"
P6_SKIP_REASON = "tools/e2e.mjs backend is unavailable"


@pytest.mark.skipif(not P6_RUNNER.is_file(), reason=P6_SKIP_REASON)
def test_starter_check_succeeds_with_p6_expectation_backend(
    tmp_path, monkeypatch, server_guard
):
    port = free_port()
    env = server_guard(
        dict(os.environ, RS_DATA_DIR=str(tmp_path / "data")),
        port,
    )
    monkeypatch.setenv("RS_DATA_DIR", env["RS_DATA_DIR"])
    monkeypatch.setenv("RS_TOOL_PORT", env["RS_TOOL_PORT"])
    monkeypatch.setenv("RS_E2E_PORT", env["RS_E2E_PORT"])
    assert check_template("_starter", ROOT) == []


def test_registry_rejects_namespace_mismatch(tmp_path):
    folder = tmp_path / "templates" / "wrong" / "sample"
    folder.mkdir(parents=True)
    (folder / "template.json").write_text(
        json.dumps(
            {
                "id": "sample",
                "namespace": "different",
                "version": 1,
                "title_de": "Test",
                "description": "Test",
                "components": [],
                "strings": [],
            }
        ),
        encoding="utf-8",
    )
    for name in ("template.html", "schema.json", "result.schema.json", "README.md"):
        (folder / name).write_text("{}" if name.endswith(".json") else "x", encoding="utf-8")
    with pytest.raises(RegistryError, match="namespace"):
        scan_registry(tmp_path / "templates")


def test_check_rejects_forbidden_template_api(tmp_path):
    target = install_minimal_template(tmp_path)
    (target / "template.js").write_text("fetch('https://example.com')", encoding="utf-8")
    findings = check_template("_starter", tmp_path)
    assert any("forbidden" in finding.lower() for finding in findings)


@pytest.mark.parametrize("invalid_type", [None, [], {}])
def test_finding_3_check_and_serve_report_malformed_schema_types(
    tmp_path, invalid_type
):
    target = install_minimal_template(tmp_path)
    (target / "schema.json").write_text(
        json.dumps({"type": invalid_type}), encoding="utf-8"
    )
    for selection in ("_starter", "--all"):
        findings = check_template(selection, tmp_path)
        assert findings
        assert any("type" in finding for finding in findings)
    registry = scan_registry(tmp_path / "templates")
    data_dir = ensure_layout(tmp_path / "data")
    with pytest.raises(RegistryError, match="type"):
        ReportHTTPServer(
            ("127.0.0.1", 0), Handler, data_dir, registry, load_config(data_dir)
        )


@pytest.mark.parametrize("invalid_id", [None, [], {}])
def test_finding_3_registry_reports_non_string_manifest_id(tmp_path, invalid_id):
    target = install_minimal_template(tmp_path)
    manifest_path = target / "template.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["id"] = invalid_id
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(RegistryError, match="invalid template id"):
        scan_registry(tmp_path / "templates")
    findings = check_template("_starter", tmp_path)
    assert findings and "invalid template id" in findings[0]


def test_finding_6_root_oneof_contract_preserves_errors_and_starts_server(
    tmp_path
):
    target = install_minimal_template(tmp_path)
    schema = {
        "oneOf": [
            {
                "type": "object",
                "properties": {
                    "message": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 2000,
                    }
                },
                "required": ["message"],
                "additionalProperties": False,
            },
            {"type": "null"},
        ]
    }
    (target / "schema.json").write_text(json.dumps(schema), encoding="utf-8")
    fixtures = target / "fixtures"
    values = {
        "golden.json": {"message": "Hello"},
        "edge-max.json": None,
        "edge-unicode.json": {"message": "Grüße"},
        "invalid-empty.json": {"message": ""},
        "invalid-type.json": 42,
    }
    for name, value in values.items():
        (fixtures / name).write_text(json.dumps(value), encoding="utf-8")
    assert check_template("_starter", tmp_path) == []
    registry = scan_registry(tmp_path / "templates")
    data_dir = ensure_layout(tmp_path / "data")
    server = ReportHTTPServer(
        ("127.0.0.1", 0), Handler, data_dir, registry, load_config(data_dir)
    )
    server.server_close()


def test_finding_8_check_rejects_non_json_fixture_constants(tmp_path):
    target = install_minimal_template(tmp_path)
    (target / "fixtures" / "golden.json").write_text(
        '{"message":NaN}', encoding="utf-8"
    )
    findings = check_template("_starter", tmp_path)
    assert any("golden.json" in finding and "invalid JSON" in finding for finding in findings)


def test_check_visual_missing_tool_is_clear(tmp_path):
    install_minimal_template(tmp_path)
    findings = check_template("_starter", tmp_path, visual=True)
    assert any("tools/visual.mjs is missing" in finding for finding in findings)


@pytest.mark.parametrize(
    "source",
    [
        "fetch /* gap */ ('/hello')",
        "eval /* gap */ ('1')",
        "new /* gap */ Function ('return 1')",
        "import /* gap */ ('module')",
        "new XMLHttpRequest ()",
        "new WebSocket ('ws://example')",
        "new EventSource ('/events')",
        "navigator /* gap */ . clipboard",
    ],
)
def test_check_rejects_whitespace_or_comment_obfuscated_forbidden_apis(
    tmp_path, source
):
    target = install_minimal_template(tmp_path)
    (target / "template.js").write_text(source, encoding="utf-8")
    assert any("forbidden API" in finding for finding in check_template("_starter", tmp_path))


@pytest.mark.parametrize(
    "source",
    [
        'const request = new XMLHttpRequest; request.open("GET", "/hello"); request.send();',
        'const request = fetch; request("/hello");',
        "const socketFactory = WebSocket;",
        "const sourceFactory = EventSource;",
        "const run = eval;",
        "const workerLoad = importScripts;",
        'navigator.sendBeacon("/hello", "x");',
        'window["fetch"]("/hello");',
        'globalThis [ "safeLookingAlias" ];',
    ],
)
def test_finding_4_token_scan_rejects_forbidden_api_references(tmp_path, source):
    target = install_minimal_template(tmp_path)
    (target / "template.js").write_text(source, encoding="utf-8")
    assert any(
        "forbidden API" in finding
        for finding in check_template("_starter", tmp_path)
    )


def test_finding_4_token_scan_ignores_comments_and_literals(tmp_path):
    target = install_minimal_template(tmp_path)
    (target / "template.js").write_text(
        """
        // fetch and navigator.clipboard
        const ordinary = "XMLHttpRequest";
        const template = `WebSocket and ${"EventSource"}`;
        """,
        encoding="utf-8",
    )
    assert not any(
        "forbidden API" in finding
        for finding in check_template("_starter", tmp_path)
    )


@pytest.mark.parametrize(
    "source",
    [
        'const hidden = `${fetch("/hello")}`;',
        'const hidden = `${`${fetch("/hello")}`}`;',
        r"const request = f\u0065tch; request('/hello');",
        r"const request = \u{66}etch; request('/hello');",
        'navigator["clipboard"].writeText(RS.data.message);',
        'self["fetch"]("/hello");',
        'window[`fetch`]("/hello");',
    ],
)
def test_finding_3_lint_scans_template_expressions_escaped_identifiers_and_computed_access(
    tmp_path, source
):
    target = install_minimal_template(tmp_path)
    (target / "template.js").write_text(source, encoding="utf-8")
    assert any(
        "forbidden API" in finding
        for finding in check_template("_starter", tmp_path)
    )


def test_finding_3_lint_keeps_template_comment_and_string_controls_valid(
    tmp_path
):
    target = install_minimal_template(tmp_path)
    (target / "template.js").write_text(
        """
        // `${fetch("/hello")}`
        const literal = `fetch navigator["clipboard"]`;
        const expressionString = `${"fetch"}`;
        """,
        encoding="utf-8",
    )
    assert not any(
        "forbidden API" in finding
        for finding in check_template("_starter", tmp_path)
    )


@pytest.mark.parametrize(
    "source",
    [
        'const clean = RS.data.message.replace(/"/g, ""); fetch("/hello");',
        'const value = `${ /}/.test(RS.data.message) ? fetch("/hello") : RS.data.message }`;',
    ],
)
def test_finding_2_regex_literals_do_not_hide_forbidden_calls(tmp_path, source):
    target = install_minimal_template(tmp_path)
    (target / "template.js").write_text(source, encoding="utf-8")
    assert any(
        "forbidden API" in finding
        for finding in check_template("_starter", tmp_path)
    )
    registry = scan_registry(tmp_path / "templates")
    data_dir = ensure_layout(tmp_path / "data")
    with pytest.raises(RegistryError, match="forbidden API"):
        ReportHTTPServer(
            ("127.0.0.1", 0), Handler, data_dir, registry, load_config(data_dir)
        )


@pytest.mark.parametrize(
    "source",
    [
        "const value = /ordinary/.test(RS.data.message);",
        'root.querySelector("p").textContent = `${RS.data.message.replace(/}/g, "")}`;',
        r"const escaped = /[/\\]/.test(RS.data.message);",
        "const divided = value / 2 + values[0] / (total / 4);",
    ],
)
def test_finding_2_regex_literals_are_inert_and_division_stays_code(
    tmp_path, source
):
    target = install_minimal_template(tmp_path)
    (target / "template.js").write_text(source, encoding="utf-8")
    assert check_template("_starter", tmp_path) == []
    registry = scan_registry(tmp_path / "templates")
    data_dir = ensure_layout(tmp_path / "data")
    server = ReportHTTPServer(
        ("127.0.0.1", 0), Handler, data_dir, registry, load_config(data_dir)
    )
    server.server_close()


FUZZ_FORBIDDEN_REGRESSIONS = [
    ("division-46", 'let n=12; const value=n++ / fetch("/hello") / 2;'),
    ("division-47", 'let n=12; const value=n++ / (fetch("/hello"),2) / 2;'),
    ("division-50", 'let n=12; const value=n-- / fetch("/hello") / 2;'),
    ("division-51", 'let n=12; const value=n-- / (fetch("/hello"),2) / 2;'),
    (
        "division-66",
        'let n=12; const value=function f(){} / fetch("/hello") / 2;',
    ),
    (
        "division-67",
        'let n=12; const value=function f(){} / (fetch("/hello"),2) / 2;',
    ),
    (
        "regex-91",
        'if (RS.data.message) /"/.test(RS.data.message); fetch("/hello");',
    ),
    (
        "regex-93",
        'if (RS.data.message) /}/.test(RS.data.message); fetch("/hello");',
    ),
    (
        "regex-95",
        'if (RS.data.message) /["}]/.test(RS.data.message); fetch("/hello");',
    ),
    (
        "regex-97",
        r'if (RS.data.message) /\//.test(RS.data.message); fetch("/hello");',
    ),
    (
        "regex-101",
        'if (RS.data.message) /[a-z]+/i.test(RS.data.message); fetch("/hello");',
    ),
    (
        "regex-103",
        'if (RS.data.message) /https?:/.test(RS.data.message); fetch("/hello");',
    ),
    (
        "regex-107",
        'while (false) /"/.test(RS.data.message); fetch("/hello");',
    ),
    (
        "regex-109",
        'while (false) /}/.test(RS.data.message); fetch("/hello");',
    ),
    (
        "regex-111",
        'while (false) /["}]/.test(RS.data.message); fetch("/hello");',
    ),
    (
        "regex-113",
        r'while (false) /\//.test(RS.data.message); fetch("/hello");',
    ),
    (
        "regex-117",
        'while (false) /[a-z]+/i.test(RS.data.message); fetch("/hello");',
    ),
    (
        "regex-119",
        'while (false) /https?:/.test(RS.data.message); fetch("/hello");',
    ),
    (
        "regex-123",
        'for(let i=0;i<1;i++) /"/.test(RS.data.message); fetch("/hello");',
    ),
    (
        "regex-125",
        'for(let i=0;i<1;i++) /}/.test(RS.data.message); fetch("/hello");',
    ),
    (
        "regex-127",
        'for(let i=0;i<1;i++) /["}]/.test(RS.data.message); fetch("/hello");',
    ),
    (
        "regex-129",
        r'for(let i=0;i<1;i++) /\//.test(RS.data.message); fetch("/hello");',
    ),
    (
        "regex-133",
        'for(let i=0;i<1;i++) /[a-z]+/i.test(RS.data.message); fetch("/hello");',
    ),
    (
        "regex-135",
        'for(let i=0;i<1;i++) /https?:/.test(RS.data.message); fetch("/hello");',
    ),
    (
        "template-225",
        "const value=`${(()=>{if(RS.data.message) "
        '/"/.test(RS.data.message); return RS.data.message;})()}`;'
        'fetch("/hello");;',
    ),
    (
        "control-quote-fetch",
        'if (RS.data.message) /"/.test(RS.data.message); fetch("/hello");',
    ),
    (
        "postfix-fetch",
        'let n=12; const ratio=n++ / fetch("/hello") / 2;',
    ),
]


@pytest.mark.parametrize(
    ("case_name", "source"),
    FUZZ_FORBIDDEN_REGRESSIONS,
    ids=[case[0] for case in FUZZ_FORBIDDEN_REGRESSIONS],
)
def test_finding_1_fuzz_forbidden_calls_are_never_hidden(case_name, source):
    assert "fetch" in _forbidden_js_apis(source), case_name


@pytest.mark.parametrize(
    ("case_name", "source"),
    [
        (
            "regex-88",
            "if (RS.data.message) /fetch/.test(RS.data.message);",
        ),
        ("regex-104", "while (false) /fetch/.test(RS.data.message);"),
        (
            "regex-120",
            "for(let i=0;i<1;i++) /fetch/.test(RS.data.message);",
        ),
        (
            "ordinary-control-regex",
            "if (RS.data.message) /fetch/.test(RS.data.message);",
        ),
    ],
)
def test_finding_1_fuzz_regex_forbidden_names_fail_closed(case_name, source):
    findings = _forbidden_js_apis(source)
    assert any("forbidden name inside a regex literal" in item for item in findings), (
        case_name
    )


@pytest.mark.parametrize(
    "source",
    [
        'if (x) /"/.test(x); fetch("/hello");',
        'let n=12; const ratio=n-- / fetch("/hello") / 2;',
    ],
)
def test_finding_1_review_examples_fail_full_contract_and_server_startup(
    tmp_path, source
):
    target = install_minimal_template(tmp_path)
    (target / "template.js").write_text(source, encoding="utf-8")
    assert any("forbidden API" in item for item in check_template("_starter", tmp_path))
    registry = scan_registry(tmp_path / "templates")
    data_dir = ensure_layout(tmp_path / "data")
    with pytest.raises(RegistryError, match="forbidden API"):
        ReportHTTPServer(
            ("127.0.0.1", 0), Handler, data_dir, registry, load_config(data_dir)
        )


@pytest.mark.parametrize(
    "source",
    [
        'if (x) /"/.test(x);',
        'while (x) /"/.test(x);',
        'for (;x;) /"/.test(x);',
        'with (x) /"/.test(x);',
        'if (x) {} /"/.test(x);',
        '{ const x = 1; } /"/.test("x");',
        'let n=12; const ratio=n++ / 2;',
        'let n=12; const ratio=n-- / 2;',
    ],
)
def test_finding_1_control_and_postfix_regex_division_contexts_pass(source):
    assert _forbidden_js_apis(source) == []


@pytest.mark.parametrize(
    "source",
    [
        "let n=1; n++ / 2;",
        "let n=1; n-- / 2;",
        "const value={} / 2;",
        "const value=function f(){} / 2;",
        "const value=(()=>{}) / 2;",
        "call() / 2;",
    ],
)
def test_finding_1_expression_endings_force_division(source):
    assert not any(kind == "regex" for kind, _ in _js_tokens(source))


@pytest.mark.parametrize(
    "source",
    [
        'if (x) /"/.test(x);',
        'while (x) /"/.test(x);',
        'for (;x;) /"/.test(x);',
        'with (x) /"/.test(x);',
        'if (x) {} /"/.test(x);',
        '{ const x = 1; } /"/.test("x");',
    ],
)
def test_finding_1_statement_endings_allow_regex(source):
    assert any(kind == "regex" for kind, _ in _js_tokens(source))


def test_finding_1_ambiguous_context_scans_regex_and_division_union():
    for source in [
        'class Example {} /"/.test("x"); fetch("/hello");',
        'switch (x) { case 1: {} /"/.test("x"); fetch("/hello"); }',
    ]:
        assert "fetch" in _forbidden_js_apis(source)


def test_finding_1_async_function_declaration_allows_regex_and_exposes_fetch():
    source = 'async function f(){} /"/.test("x"); fetch("/hello");'
    assert any(kind == "regex" for kind, _ in _js_tokens(source))
    assert "fetch" in _forbidden_js_apis(source)


def test_finding_1_function_expression_defaults_still_force_division():
    source = (
        r'const value=function f(option={}){} / f\u0065tch("/hello") / 2;'
    )
    assert "fetch" in _forbidden_js_apis(source)


def test_finding_1_partial_navigator_regex_name_is_not_forbidden():
    assert _forbidden_js_apis(
        "const value=/navigator/.test(RS.data.message);"
    ) == []


@pytest.mark.parametrize(
    "keyword",
    [
        "return",
        "typeof",
        "case",
        "do",
        "else",
        "in",
        "of",
        "new",
        "delete",
        "void",
        "throw",
        "instanceof",
        "yield",
        "await",
    ],
)
def test_finding_1_prefix_keywords_allow_regex_literals(keyword):
    assert _forbidden_js_apis(f'{keyword} /"/.test("x");') == []


@pytest.mark.parametrize(
    "expression",
    ['`${RS.data.message}`', '`${RS.t("acknowledge")}`'],
)
def test_finding_4_localization_allows_dynamic_template_interpolation(
    tmp_path, expression
):
    target = install_minimal_template(tmp_path)
    script = (target / "template.js").read_text(encoding="utf-8")
    (target / "template.js").write_text(
        script.replace("RS.data.message", expression, 1),
        encoding="utf-8",
    )
    assert check_template("_starter", tmp_path) == []
    registry = scan_registry(tmp_path / "templates")
    data_dir = ensure_layout(tmp_path / "data")
    server = ReportHTTPServer(
        ("127.0.0.1", 0), Handler, data_dir, registry, load_config(data_dir)
    )
    server.server_close()


def test_finding_4_localization_rejects_literal_template_segments(tmp_path):
    target = install_minimal_template(tmp_path)
    script = (target / "template.js").read_text(encoding="utf-8")
    (target / "template.js").write_text(
        script.replace("RS.data.message", "`English ${RS.data.message}`", 1),
        encoding="utf-8",
    )
    assert any(
        "visible string literal" in finding
        for finding in check_template("_starter", tmp_path)
    )


@pytest.mark.parametrize(
    "html",
    [
        '<input placeholder="English secret">',
        '<button aria-label="English action"></button>',
        '<div title="English title"></div>',
        '<img alt="English alternative">',
    ],
)
def test_finding_5_rejects_literal_localized_html_attributes(tmp_path, html):
    target = install_minimal_template(tmp_path)
    (target / "template.html").write_text(html, encoding="utf-8")
    assert any(
        "localized attribute" in finding
        for finding in check_template("_starter", tmp_path)
    )


def test_finding_5_parses_unquoted_translation_keys_and_attribute_bindings(
    tmp_path
):
    target = install_minimal_template(tmp_path)
    (target / "template.html").write_text(
        """
        <span data-rs-t = missing_key></span>
        <input placeholder="" data-rs-t-placeholder = acknowledge>
        """,
        encoding="utf-8",
    )
    findings = check_template("_starter", tmp_path)
    assert any("missing_key" in finding for finding in findings)
    assert not any(
        "localized attribute 'placeholder'" in finding for finding in findings
    )


@pytest.mark.parametrize(
    "source",
    [
        'node.textContent = "English visible";',
        'node.innerText = "English visible";',
        'node.innerHTML = "<b>English visible</b>";',
        'node.placeholder = "English visible";',
        'node.title = "English visible";',
        'node.alt = "English visible";',
        'node.setAttribute("aria-label", "English visible");',
        'node.setAttribute("placeholder", "English visible");',
    ],
)
def test_finding_5_rejects_literal_localized_javascript_assignments(
    tmp_path, source
):
    target = install_minimal_template(tmp_path)
    (target / "template.js").write_text(source, encoding="utf-8")
    assert any(
        "visible string literal" in finding
        for finding in check_template("_starter", tmp_path)
    )


def test_finding_5_deep_fixture_is_a_controlled_contract_finding(tmp_path):
    target = install_minimal_template(tmp_path)
    (target / "fixtures" / "golden.json").write_text(
        "[" * 1100 + "0" + "]" * 1100,
        encoding="utf-8",
    )
    findings = check_template("_starter", tmp_path)
    assert any(
        "golden.json" in finding and "nesting" in finding
        for finding in findings
    )


def test_finding_6_large_integer_bounds_pass_contract_and_server_startup(
    tmp_path
):
    target = install_minimal_template(tmp_path)
    schema_path = target / "schema.json"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    schema["properties"]["message"]["minimum"] = -(10**400)
    schema["properties"]["message"]["maximum"] = 10**400
    schema_path.write_text(json.dumps(schema), encoding="utf-8")
    assert check_template("_starter", tmp_path) == []
    registry = scan_registry(tmp_path / "templates")
    data_dir = ensure_layout(tmp_path / "data")
    server = ReportHTTPServer(
        ("127.0.0.1", 0), Handler, data_dir, registry, load_config(data_dir)
    )
    server.server_close()


def test_finding_7_integer_valued_float_fixtures_pass_contract(tmp_path):
    target = install_minimal_template(tmp_path)
    (target / "schema.json").write_text(
        json.dumps(
            {
                "type": "object",
                "properties": {"message": {"type": "integer"}},
                "required": ["message"],
                "additionalProperties": False,
            }
        ),
        encoding="utf-8",
    )
    fixtures = target / "fixtures"
    for name, value in {
        "golden.json": 1.0,
        "edge-max.json": 1e0,
        "edge-unicode.json": -2.0,
        "invalid-empty.json": False,
        "invalid-type.json": 1.5,
    }.items():
        (fixtures / name).write_text(
            json.dumps({"message": value}),
            encoding="utf-8",
        )
    assert check_template("_starter", tmp_path) == []


@pytest.mark.parametrize(
    ("filename", "content"),
    [
        ("template.js", "fetch /* gap */ ('/hello')"),
        ("schema.json", '{"type":"mystery"}'),
    ],
)
def test_server_refuses_templates_that_fail_contract_check(tmp_path, filename, content):
    target = install_minimal_template(tmp_path)
    (target / filename).write_text(content, encoding="utf-8")
    registry = scan_registry(tmp_path / "templates")
    data_dir = ensure_layout(tmp_path / "data")
    with pytest.raises(RegistryError, match="_starter"):
        ReportHTTPServer(
            ("127.0.0.1", 0), Handler, data_dir, registry, load_config(data_dir)
        )


def _starter_with_expect(tmp_path, value):
    target = install_minimal_template(tmp_path)
    expect = target / "fixtures" / "expect"
    expect.mkdir()
    (expect / "golden.json").write_text(json.dumps(value), encoding="utf-8")
    return target


@pytest.mark.parametrize(
    "value",
    [
        {"copies": {"copy": 3}},
        {"counters": {"counter": {"count": 1, "limit": 2}}},
        {"flow": [{"unknown": "x"}]},
        {"keyboard": [{"click": "#button"}]},
        {"result": {"acknowledged": "yes"}},
    ],
)
def test_check_validates_expect_file_shape_and_result_schema(tmp_path, value):
    _starter_with_expect(tmp_path, value)
    findings = check_template("_starter", tmp_path)
    assert any("golden.json" in finding for finding in findings)


def test_check_rejects_malformed_counter_cases(tmp_path):
    target = _starter_with_expect(tmp_path, [])
    (target / "fixtures" / "expect" / "golden.json").unlink()
    (target / "fixtures" / "expect" / "counter-cases.json").write_text(
        json.dumps([{"name": "case", "platform": "x", "text": "x", "count": True, "over": False}]),
        encoding="utf-8",
    )
    assert any("counter-cases.json" in finding for finding in check_template("_starter", tmp_path))


def test_isolated_check_reports_missing_expectation_backend_clearly(tmp_path):
    _starter_with_expect(tmp_path, {"copies": {}, "counters": {}, "flow": [], "keyboard": []})
    findings = check_template("_starter", tmp_path)
    assert any("tools/e2e.mjs is missing" in finding for finding in findings)


def test_check_runs_expect_backend_and_surfaces_changed_value_failure(
    tmp_path, monkeypatch
):
    _starter_with_expect(
        tmp_path,
        {
            "copies": {"starter-copy": "changed expected value"},
            "counters": {},
            "flow": [],
            "keyboard": [],
        },
    )
    tool = tmp_path / "tools" / "e2e.mjs"
    tool.parent.mkdir()
    tool.write_text("", encoding="utf-8")
    calls = []

    def run(args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(returncode=1, stderr="copy mismatch", stdout="")

    monkeypatch.setattr(check_module.subprocess, "run", run)
    findings = check_template("_starter", tmp_path)
    assert calls[0][0] == ["node", str(tool), "expect", "_starter"]
    assert any("copy mismatch" in finding for finding in findings)


@pytest.mark.parametrize(
    ("visual", "tool_name"),
    [(False, "e2e.mjs"), (True, "visual.mjs")],
)
def test_finding_5_node_tool_output_is_decoded_as_utf8(
    tmp_path, monkeypatch, visual, tool_name
):
    target = install_minimal_template(tmp_path)
    if not visual:
        expect = target / "fixtures" / "expect"
        expect.mkdir()
        (expect / "golden.json").write_text(
            json.dumps(
                {"copies": {}, "counters": {}, "flow": [], "keyboard": []}
            ),
            encoding="utf-8",
        )
    tool = tmp_path / "tools" / tool_name
    tool.parent.mkdir(exist_ok=True)
    expected = '{"message":"Grüße 😀"}'
    tool.write_text(
        "import sys\n"
        f"sys.stdout.buffer.write(({expected!r} + '\\n').encode('utf-8'))\n"
        "raise SystemExit(1)\n",
        encoding="utf-8",
    )
    real_run = subprocess.run

    def run_fake_node(args, **kwargs):
        assert args[:2] == ["node", str(tool)]
        return real_run([sys.executable, str(tool), *args[2:]], **kwargs)

    monkeypatch.setattr(check_module.subprocess, "run", run_fake_node)
    findings = check_template("_starter", tmp_path, visual=visual)
    assert expected in findings
