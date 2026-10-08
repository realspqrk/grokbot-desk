#!/usr/bin/env python3
"""Static source-policy checks for C3/C15a and opt-in C16 calm rules."""
import argparse
import ast
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path


def _finding(rule, path, line, message):
    return {"rule": rule, "path": path.as_posix(), "line": line, "message": message}


def _call_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _call_name(node.value)
        return f"{parent}.{node.attr}" if parent else node.attr
    return ""


def _constants(node):
    return [item.value for item in ast.walk(node) if isinstance(item, ast.Constant) and isinstance(item.value, str)]


def _scan_python(path, relative, local_modules):
    findings = []
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(relative))
    except (OSError, SyntaxError) as error:
        return [_finding("syntax", relative, getattr(error, "lineno", 0) or 0, str(error))]
    allowed_external = {"tzdata"}
    in_tests_or_tools = relative.parts and relative.parts[0] in {"tests", "tools"}
    if in_tests_or_tools:
        allowed_external.add("pytest")
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            if isinstance(node, ast.ImportFrom) and node.level:
                continue
            names = [alias.name for alias in node.names] if isinstance(node, ast.Import) else [node.module or ""]
            for name in names:
                top = name.split(".", 1)[0]
                if top == "webbrowser":
                    findings.append(_finding("C3", relative, node.lineno, "webbrowser is forbidden"))
                if top and top not in sys.stdlib_module_names and top not in allowed_external and top not in local_modules:
                    findings.append(_finding("C15a", relative, node.lineno, f"non-stdlib import: {top}"))
        if isinstance(node, ast.Call):
            name = _call_name(node.func)
            if name == "os.startfile":
                findings.append(_finding("C3", relative, node.lineno, "os.startfile is forbidden"))
            if name.endswith(("Popen", "run", "call", "check_call", "check_output")):
                shell_true = any(
                    keyword.arg == "shell"
                    and isinstance(keyword.value, ast.Constant)
                    and keyword.value.value is True
                    for keyword in node.keywords
                )
                text = " ".join(_constants(node)).lower()
                if shell_true and ("http://" in text or "https://" in text or " start " in f" {text} "):
                    findings.append(_finding("C3", relative, node.lineno, "shell URL/default-browser launch is forbidden"))
                if any(value.strip().lower() == "start" for value in _constants(node)):
                    findings.append(_finding("C3", relative, node.lineno, "start command is forbidden"))
    return findings


_SPACING_DECLARATION = re.compile(
    r"(?:^|[;{])\s*"
    r"(?P<property>(?:margin|padding|inset)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|gap|row-gap|column-gap)"
    r"\s*:\s*(?P<value>[^;{}]+)",
    re.IGNORECASE | re.MULTILINE,
)
_ALLOWED_SPACING_VALUE = re.compile(
    r"(?:0|1px|var\(--space-[a-z0-9-]+\))",
    re.IGNORECASE,
)
_JS_STYLE_ASSIGNMENT = re.compile(
    r"\.style\.(?P<property>"
    r"(?:margin|padding|inset)(?:Top|Right|Bottom|Left|Block|Inline)?"
    r"(?:Start|End)?|gap|rowGap|columnGap"
    r")\s*=\s*(?P<quote>['\"`])(?P<value>.*?)(?P=quote)",
    re.DOTALL,
)
_JS_SET_PROPERTY = re.compile(
    r"\.style\.setProperty\(\s*"
    r"(?P<property_quote>['\"`])(?P<property>"
    r"(?:margin|padding|inset)(?:-(?:top|right|bottom|left|block|inline)"
    r"(?:-(?:start|end))?)?|gap|row-gap|column-gap"
    r")(?P=property_quote)\s*,\s*"
    r"(?P<value_quote>['\"`])(?P<value>.*?)(?P=value_quote)",
    re.IGNORECASE | re.DOTALL,
)
_JS_CSS_TEXT = re.compile(
    r"\.style\.cssText\s*=\s*"
    r"(?P<quote>['\"])(?P<value>.*?)(?P=quote)",
    re.DOTALL,
)
_JS_SET_STYLE_ATTRIBUTE = re.compile(
    r"\.setAttribute\(\s*['\"]style['\"]\s*,\s*"
    r"(?P<quote>['\"])(?P<value>.*?)(?P=quote)",
    re.IGNORECASE | re.DOTALL,
)
_JS_TEMPLATE_LITERAL = re.compile(r"`(?P<value>(?:\\.|[^`])*)`", re.DOTALL)


def _spacing_findings(text, relative, *, line_offset=0):
    findings = []
    without_comments = re.sub(
        r"/\*.*?\*/",
        lambda match: "\n" * match.group().count("\n"),
        text,
        flags=re.DOTALL,
    )
    for match in _SPACING_DECLARATION.finditer(without_comments):
        value = re.sub(
            r"\s*!important\s*$",
            "",
            match.group("value"),
            flags=re.IGNORECASE,
        ).strip()
        tokens = value.split()
        if not tokens or any(
            _ALLOWED_SPACING_VALUE.fullmatch(token) is None for token in tokens
        ):
            line = line_offset + without_comments.count("\n", 0, match.start()) + 1
            findings.append(_finding(
                "C16-K7a",
                relative,
                line,
                f"{match.group('property')} uses raw spacing: {value}",
            ))
    return findings


def _js_property_name(value):
    return re.sub(r"(?<!^)([A-Z])", r"-\1", value).lower()


def _scan_calm_js(path, relative):
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        return [_finding("C16-K7a", relative, 0, str(error))]
    findings = []
    for pattern in (_JS_STYLE_ASSIGNMENT, _JS_SET_PROPERTY):
        for match in pattern.finditer(text):
            value = match.group("value").strip()
            tokens = value.split()
            if tokens and all(
                _ALLOWED_SPACING_VALUE.fullmatch(token) is not None
                for token in tokens
            ):
                continue
            findings.append(_finding(
                "C16-K7a",
                relative,
                text.count("\n", 0, match.start()) + 1,
                f"{_js_property_name(match.group('property'))} uses raw spacing: {value}",
            ))
    for pattern in (_JS_CSS_TEXT, _JS_SET_STYLE_ATTRIBUTE):
        for match in pattern.finditer(text):
            findings.extend(_spacing_findings(
                match.group("value"),
                relative,
                line_offset=text.count("\n", 0, match.start("value")),
            ))
    for match in _JS_TEMPLATE_LITERAL.finditer(text):
        findings.extend(_spacing_findings(
            match.group("value"),
            relative,
            line_offset=text.count("\n", 0, match.start("value")),
        ))
    return findings


class _CalmHTMLParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.in_style = False
        self.styles = []
        self.style_attributes = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() == "style":
            self.in_style = True
        for name, value in attrs:
            if name.lower() == "style" and value is not None:
                self.style_attributes.append((self.getpos()[0], value))

    def handle_endtag(self, tag):
        if tag.lower() == "style":
            self.in_style = False

    def handle_data(self, data):
        if self.in_style:
            self.styles.append((self.getpos()[0], data))


def _scan_calm_html(path, relative, *, check_primaries):
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        return [_finding("C16-K7a", relative, 0, str(error))]
    parser = _CalmHTMLParser()
    try:
        parser.feed(text)
    except Exception as error:
        return [_finding("C16-K7a", relative, 0, f"invalid HTML: {error}")]
    findings = []
    for line, css in parser.styles + parser.style_attributes:
        findings.extend(_spacing_findings(
            css,
            relative,
            line_offset=line - 1,
        ))
    if check_primaries:
        matches = list(re.finditer(r"\bdata-rs-primary\b", text))
        if len(matches) > 1:
            findings.append(_finding(
                "C16-K1-primary-count",
                relative,
                text.count("\n", 0, matches[1].start()) + 1,
                f"template declares {len(matches)} data-rs-primary markers; maximum is 1",
            ))
    return findings


def _scan_calm(root):
    findings = []
    css_paths = [
        *root.glob("core/**/*.css"),
        *root.glob("templates/**/*.css"),
    ]
    for path in sorted(set(css_paths)):
        relative = path.relative_to(root)
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as error:
            findings.append(_finding("C16-K7a", relative, 0, str(error)))
            continue
        findings.extend(_spacing_findings(text, relative))
    html_paths = [
        *((path, False) for path in root.glob("core/static/*.html")),
        *((path, True) for path in root.glob("templates/**/template.html")),
    ]
    for path, check_primaries in sorted(html_paths, key=lambda item: str(item[0])):
        relative = path.relative_to(root)
        findings.extend(_scan_calm_html(
            path,
            relative,
            check_primaries=check_primaries,
        ))
    js_paths = [
        *root.glob("core/**/*.js"),
        *root.glob("core/**/*.mjs"),
        *root.glob("templates/**/template.js"),
        *root.glob("templates/**/template.mjs"),
    ]
    for path in sorted(set(js_paths)):
        relative = path.relative_to(root)
        findings.extend(_scan_calm_js(path, relative))
    return findings


def scan_repo(root, *, calm=False):
    root = Path(root)
    findings = []
    local_modules = {path.name for path in root.iterdir() if path.is_dir()}
    local_modules.update(path.stem for path in root.rglob("*.py"))
    for path in sorted(root.rglob("*.py")):
        relative = path.relative_to(root)
        if relative.parts[:2] == ("tools", "probes") or any(part in {".git", "__pycache__"} for part in relative.parts):
            continue
        findings.extend(_scan_python(path, relative, local_modules))
    for path in sorted(root.rglob("package.json")):
        relative = path.relative_to(root)
        try:
            package = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            findings.append(_finding("C15a", relative, 0, f"invalid package.json: {error}"))
            continue
        for key in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
            if package.get(key):
                findings.append(_finding("C15a", relative, 0, f"package.json {key} must be empty"))
    install_markers = ("pip" + " install", "npm" + " install")
    for suffix in ("*.cmd", "*.bat", "*.ps1", "*.sh"):
        for path in sorted(root.rglob(suffix)):
            relative = path.relative_to(root)
            if relative.parts[:2] == ("tools", "probes"):
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="replace").lower()
            except OSError:
                continue
            for marker in install_markers:
                if marker in text:
                    findings.append(_finding("C15a", relative, 0, f"install command is forbidden: {marker}"))
    if calm:
        findings.extend(_scan_calm(root))
    return findings


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--calm", action="store_true", help="include C16 calm source rules")
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parents[1]
    findings = scan_repo(root, calm=args.calm)
    print(json.dumps({"ok": not findings, "findings": findings}, ensure_ascii=False, separators=(",", ":")))
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
