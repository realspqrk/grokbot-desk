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


def test_lint_allows_startfile_only_for_the_url_opener(tmp_path):
    windows = tmp_path / "core"
    windows.mkdir()
    (windows / "platform_windows.py").write_text(
        "import os\n\ndef open_url(url):\n    os.startfile(url)\n\ndef other():\n    os.startfile('report.html')\n",
        encoding="utf-8",
    )
    findings = scan_repo(tmp_path)
    assert len(findings) == 1
    assert findings[0]["message"] == "os.startfile is forbidden"
    assert findings[0]["line"] == 7


def test_lint_allows_pytest_only_in_tests(tmp_path):
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "test_ok.py").write_text("import pytest\n", encoding="utf-8")
    assert scan_repo(tmp_path) == []


def test_lint_skips_a_local_virtualenv_and_node_modules(tmp_path):
    """A developer's .venv or node_modules in the clone is third-party code:
    it neither fails the lint nor makes its packages count as local."""
    site = tmp_path / ".venv" / "lib" / "python3.12" / "site-packages"
    (site / "requests").mkdir(parents=True)
    (site / "requests" / "__init__.py").write_text("import urllib3\n", encoding="utf-8")
    (site / "activate.sh").write_text("pip" + " install x\n", encoding="utf-8")
    package = tmp_path / "node_modules" / "some-package"
    package.mkdir(parents=True)
    (package / "package.json").write_text('{"dependencies": {"x": "1"}}', encoding="utf-8")
    assert scan_repo(tmp_path) == []

    (tmp_path / "bad.py").write_text("import requests\n", encoding="utf-8")
    assert {item["rule"] for item in scan_repo(tmp_path)} == {"C15a"}


def test_calm_lint_is_opt_in_and_rejects_raw_spacing(tmp_path):
    core = tmp_path / "core" / "static"
    core.mkdir(parents=True)
    (core / "shell.css").write_text(".bad { padding: 12px; }\n", encoding="utf-8")
    (core / "blocks.css").write_text(".bad { gap: 8px 0; }\n", encoding="utf-8")
    # templates are gone: a leftover folder is not desk code
    leftover = tmp_path / "templates" / "global" / "sample"
    leftover.mkdir(parents=True)
    (leftover / "template.css").write_text(".old { gap: 8px; }\n", encoding="utf-8")

    assert scan_repo(tmp_path) == []
    findings = scan_repo(tmp_path, calm=True)

    assert sum(item["rule"] == "C16-K7a" for item in findings) == 2
    assert all("templates" not in item["path"] for item in findings)


def test_calm_lint_allows_spacing_tokens_zero_and_hairlines(tmp_path):
    core = tmp_path / "core"
    core.mkdir()
    (core / "tokens.css").write_text(
        ".ok { margin: 0 var(--space-4); padding: 1px; gap: var(--space-2); inset: 0; }\n",
        encoding="utf-8",
    )

    assert scan_repo(tmp_path, calm=True) == []


def test_review_finding_7_calm_lint_scans_inline_page_styles(tmp_path):
    static = tmp_path / "core" / "static"
    static.mkdir(parents=True)
    (static / "shell.html").write_text(
        '<style>.also-bad { margin: 19px; }</style>'
        '<section style="padding:37px;gap:11px"></section>',
        encoding="utf-8",
    )

    findings = scan_repo(tmp_path, calm=True)

    assert sum(item["rule"] == "C16-K7a" for item in findings) == 3


def test_review_finding_7_calm_lint_does_not_parse_token_names_as_spacing_properties(
    tmp_path,
):
    static = tmp_path / "core" / "static"
    static.mkdir(parents=True)
    (static / "blocks.css").write_text(
        ":root { --space-gap: 16px; } section { gap: var(--space-gap); }",
        encoding="utf-8",
    )

    assert scan_repo(tmp_path, calm=True) == []


def test_round_2_finding_7_calm_lint_scans_core_html_and_unquoted_styles(tmp_path):
    core = tmp_path / "core" / "static"
    core.mkdir(parents=True)
    (core / "shell.html").write_text(
        '<style>.bad { margin:19px }</style>'
        '<section style="padding:37px;gap:11px"></section>',
        encoding="utf-8",
    )
    (core / "doorbell.html").write_text(
        "<section style=padding:23px></section>",
        encoding="utf-8",
    )

    findings = scan_repo(tmp_path, calm=True)

    assert sum(item["rule"] == "C16-K7a" for item in findings) == 4


def test_round_3_finding_9_calm_lint_scans_js_spacing_sources(tmp_path):
    core = tmp_path / "core" / "static"
    core.mkdir(parents=True)
    (core / "rs.js").write_text(
        "node.style.padding = '37px';\n"
        'node.style.rowGap = "11px";\n'
        "node.style.margin = 'var(--space-2)';\n",
        encoding="utf-8",
    )
    (core / "blocks.js").write_text(
        "const rules = css`.card { gap: 19px; }`;\n"
        "node.style.setProperty('padding-inline', '23px');\n",
        encoding="utf-8",
    )

    findings = scan_repo(tmp_path, calm=True)

    assert sum(item["rule"] == "C16-K7a" for item in findings) == 4


def test_round_4_finding_6_calm_lint_scans_js_style_strings(tmp_path):
    static = tmp_path / "core" / "static"
    static.mkdir(parents=True)
    (static / "blocks.js").write_text(
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
