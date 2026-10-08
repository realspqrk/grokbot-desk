from pathlib import Path

from tools.lint_src import scan_repo


def test_lint_finds_nonstdlib_and_default_browser_patterns(tmp_path):
    (tmp_path / "bad.py").write_text(
        "import requests\nimport webbrowser\nwebbrowser.open('https://example.com')\n",
        encoding="utf-8",
    )
    findings = scan_repo(tmp_path)
    rules = {finding["rule"] for finding in findings}
    assert {"C15a", "C3"} <= rules


def test_lint_allows_pytest_only_in_tests(tmp_path):
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "test_ok.py").write_text("import pytest\n", encoding="utf-8")
    assert scan_repo(tmp_path) == []


def test_calm_lint_is_opt_in_and_rejects_raw_spacing_and_multiple_primaries(tmp_path):
    core = tmp_path / "core" / "static"
    template = tmp_path / "templates" / "global" / "sample"
    core.mkdir(parents=True)
    template.mkdir(parents=True)
    (core / "shell.css").write_text(".bad { padding: 12px; }\n", encoding="utf-8")
    (template / "template.css").write_text(".bad { gap: 8px 0; }\n", encoding="utf-8")
    (template / "template.html").write_text(
        '<button data-rs-primary>One</button><button data-rs-primary>Two</button>',
        encoding="utf-8",
    )

    assert scan_repo(tmp_path) == []
    findings = scan_repo(tmp_path, calm=True)

    assert sum(item["rule"] == "C16-K7a" for item in findings) == 2
    assert sum(item["rule"] == "C16-K1-primary-count" for item in findings) == 1


def test_calm_lint_allows_spacing_tokens_zero_and_hairlines(tmp_path):
    core = tmp_path / "core"
    template = tmp_path / "templates" / "global" / "sample"
    core.mkdir()
    template.mkdir(parents=True)
    (core / "tokens.css").write_text(
        ".ok { margin: 0 var(--space-4); padding: 1px; gap: var(--space-2); inset: 0; }\n",
        encoding="utf-8",
    )
    (template / "template.html").write_text(
        '<button data-rs-primary>Only</button>',
        encoding="utf-8",
    )

    assert scan_repo(tmp_path, calm=True) == []


def test_review_finding_7_calm_lint_scans_inline_template_styles(tmp_path):
    template = tmp_path / "templates" / "global" / "sample"
    template.mkdir(parents=True)
    (template / "template.html").write_text(
        '<style>.also-bad { margin: 19px; }</style>'
        '<section style="padding:37px;gap:11px"></section>',
        encoding="utf-8",
    )

    findings = scan_repo(tmp_path, calm=True)

    assert sum(item["rule"] == "C16-K7a" for item in findings) == 3


def test_review_finding_7_calm_lint_does_not_parse_token_names_as_spacing_properties(
    tmp_path,
):
    template = tmp_path / "templates" / "global" / "sample"
    template.mkdir(parents=True)
    (template / "template.css").write_text(
        ":root { --space-gap: 16px; } section { gap: var(--space-gap); }",
        encoding="utf-8",
    )

    assert scan_repo(tmp_path, calm=True) == []


def test_round_2_finding_7_calm_lint_scans_core_html_and_unquoted_styles(tmp_path):
    core = tmp_path / "core" / "static"
    template = tmp_path / "templates" / "global" / "sample"
    core.mkdir(parents=True)
    template.mkdir(parents=True)
    (core / "shell.html").write_text(
        '<style>.bad { margin:19px }</style>'
        '<section style="padding:37px;gap:11px"></section>',
        encoding="utf-8",
    )
    (template / "template.html").write_text(
        "<section style=padding:23px></section>",
        encoding="utf-8",
    )

    findings = scan_repo(tmp_path, calm=True)

    assert sum(item["rule"] == "C16-K7a" for item in findings) == 4


def test_round_3_finding_9_calm_lint_scans_js_spacing_sources(tmp_path):
    core = tmp_path / "core" / "static"
    template = tmp_path / "templates" / "global" / "sample"
    core.mkdir(parents=True)
    template.mkdir(parents=True)
    (core / "rs.js").write_text(
        "node.style.padding = '37px';\n"
        'node.style.rowGap = "11px";\n'
        "node.style.margin = 'var(--space-2)';\n",
        encoding="utf-8",
    )
    (template / "template.js").write_text(
        "const rules = css`.card { gap: 19px; }`;\n"
        "node.style.setProperty('padding-inline', '23px');\n",
        encoding="utf-8",
    )

    findings = scan_repo(tmp_path, calm=True)

    assert sum(item["rule"] == "C16-K7a" for item in findings) == 4


def test_round_4_finding_6_calm_lint_scans_js_style_strings(tmp_path):
    template = tmp_path / "templates" / "global" / "sample"
    template.mkdir(parents=True)
    (template / "template.js").write_text(
        "node.style.cssText = 'padding:37px;gap:11px';\n"
        "node.setAttribute('style', 'margin:19px;column-gap:13px');\n"
        "safe.style.cssText = 'padding:var(--space-2);gap:0';\n"
        "safe.setAttribute('style', 'margin:1px;row-gap:var(--space-3)');\n",
        encoding="utf-8",
    )

    findings = scan_repo(tmp_path, calm=True)

    spacing = [item for item in findings if item["rule"] == "C16-K7a"]
    assert len(spacing) == 4
    assert {item["line"] for item in spacing} == {1, 2}
