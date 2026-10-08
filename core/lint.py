"""Static checks for template-owned HTML, CSS, and JavaScript."""
import re
from html.parser import HTMLParser


ALLOWED_CUSTOM = {
    "rs-card", "rs-action-row", "rs-copy", "rs-badge", "rs-counter",
    "rs-post-frame", "rs-confirm",
}


_IDENTIFIER_ESCAPE = re.compile(
    r"\\u(?:([0-9a-fA-F]{4})|\{([0-9a-fA-F]{1,6})\})"
)
_NUMBER = re.compile(
    r"(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|"
    r"(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?:n\b)?"
)
_REGEX_PREFIX_KEYWORDS = {
    "await",
    "case",
    "delete",
    "do",
    "else",
    "in",
    "instanceof",
    "new",
    "of",
    "return",
    "throw",
    "typeof",
    "void",
    "yield",
}
_CONTROL_KEYWORDS = {"for", "if", "while", "with"}
_FORBIDDEN_REFERENCES = {
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "EventSource",
    "eval",
    "importScripts",
}


def _identifier_escape(source, index):
    match = _IDENTIFIER_ESCAPE.match(source, index)
    if not match:
        return None
    codepoint = int(match.group(1) or match.group(2), 16)
    if codepoint > 0x10FFFF:
        return None
    return chr(codepoint), match.end()


def _read_identifier(source, index):
    value = []
    while index < len(source):
        char = source[index]
        if char.isalnum() or char in {"_", "$"}:
            value.append(char)
            index += 1
            continue
        escaped = _identifier_escape(source, index)
        if escaped is None:
            break
        decoded, index = escaped
        value.append(decoded)
    return "".join(value), index


def _read_quoted_string(source, index):
    quote = source[index]
    index += 1
    value = []
    while index < len(source):
        char = source[index]
        if char == "\\":
            value.append(char)
            if index + 1 < len(source):
                value.append(source[index + 1])
            index += 2
            continue
        if char == quote:
            return "".join(value), index + 1
        value.append(char)
        index += 1
    return "".join(value), index


def _read_regex_literal(source, index):
    start = index
    index += 1
    in_class = False
    while index < len(source):
        char = source[index]
        if char == "\\":
            index += 2
            continue
        if char in "\r\n\u2028\u2029":
            return None
        if char == "[" and not in_class:
            in_class = True
        elif char == "]" and in_class:
            in_class = False
        elif char == "/" and not in_class:
            index += 1
            while index < len(source) and source[index].isalpha():
                index += 1
            return source[start:index], index
        index += 1
    return None


def _regex_allowed(tokens):
    if not tokens:
        return True
    kind, value = tokens[-1]
    if kind == "identifier":
        return value in _REGEX_PREFIX_KEYWORDS
    if kind in {
        "expression_close",
        "number",
        "postfix",
        "regex",
        "string",
        "template_end",
    }:
        return False
    if kind in {"block_close", "control_close"}:
        return True
    if kind == "ambiguous_close":
        return None
    return value not in {")", "]", "}", "."}


def _read_template(source, index, ambiguous_regex=True):
    tokens = [("template_start", "`")]
    index += 1
    segment = []
    while index < len(source):
        char = source[index]
        if char == "\\":
            segment.append(char)
            if index + 1 < len(source):
                segment.append(source[index + 1])
            index += 2
            continue
        if char == "`":
            tokens.append(("template_segment", "".join(segment)))
            tokens.append(("template_end", "`"))
            return tokens, index + 1
        if source.startswith("${", index):
            tokens.append(("template_segment", "".join(segment)))
            segment = []
            tokens.append(("template_expression_start", "${"))
            expression, index = _scan_js(
                source,
                index + 2,
                stop_at_brace=True,
                ambiguous_regex=ambiguous_regex,
            )
            tokens.extend(expression)
            tokens.append(("template_expression_end", "}"))
            continue
        segment.append(char)
        index += 1
    tokens.append(("template_segment", "".join(segment)))
    return tokens, index


def _scan_js(source, index=0, stop_at_brace=False, ambiguous_regex=True):
    tokens = []
    parens = []
    braces = []
    functions = []
    while index < len(source):
        char = source[index]
        if char.isspace():
            index += 1
            continue
        if source.startswith("//", index):
            end = source.find("\n", index + 2)
            index = len(source) if end < 0 else end + 1
            continue
        if source.startswith("/*", index):
            end = source.find("*/", index + 2)
            index = len(source) if end < 0 else end + 2
            continue
        regex_allowed = _regex_allowed(tokens)
        if char == "/" and (
            regex_allowed is True
            or (regex_allowed is None and ambiguous_regex)
        ):
            regex = _read_regex_literal(source, index)
            if regex is not None:
                value, index = regex
                tokens.append(("regex", value))
                continue
        if stop_at_brace and char == "}":
            if not braces:
                return tokens, index + 1
        if char == "}":
            context = braces.pop() if braces else "ambiguous"
            close_kind = {
                "block": "block_close",
                "expression": "expression_close",
            }.get(context, "ambiguous_close")
            tokens.append((close_kind, char))
            index += 1
            continue
        if char == "{":
            previous_kind, previous = tokens[-1] if tokens else (None, None)
            ready_function = next(
                (
                    cursor
                    for cursor in range(len(functions) - 1, -1, -1)
                    if functions[cursor]["ready"]
                ),
                None,
            )
            if ready_function is not None:
                function = functions.pop(ready_function)
                context = (
                    "expression" if function["expression"] else "block"
                )
            elif (
                len(tokens) >= 2
                and tokens[-2][1] == "="
                and tokens[-1][1] == ">"
            ):
                context = "expression"
            elif (
                not tokens
                or previous in {";", "{"}
                or previous_kind in {"block_close", "control_close"}
                or (
                    previous_kind == "identifier"
                    and previous in {"do", "else", "finally", "try"}
                )
            ):
                context = "block"
            elif previous == ")":
                context = "block"
            elif previous == ":":
                context = "ambiguous"
            elif regex_allowed is True:
                context = "expression"
            else:
                context = "ambiguous"
            braces.append(context)
            tokens.append(("punctuation", char))
            index += 1
            continue
        if char in {"'", '"'}:
            value, index = _read_quoted_string(source, index)
            tokens.append(("string", value))
            continue
        if char == "`":
            template, index = _read_template(
                source, index, ambiguous_regex=ambiguous_regex
            )
            tokens.extend(template)
            continue
        if (
            char.isalpha()
            or char in {"_", "$"}
            or _identifier_escape(source, index) is not None
        ):
            value, index = _read_identifier(source, index)
            if value == "function":
                previous_kind, previous = (
                    tokens[-1] if tokens else (None, None)
                )
                async_declaration = previous == "async" and (
                    len(tokens) == 1
                    or tokens[-2][1] in {";", "{"}
                    or tokens[-2][0] in {"block_close", "control_close"}
                )
                declaration = (
                    not tokens
                    or previous in {";", "{"}
                    or previous_kind in {"block_close", "control_close"}
                    or async_declaration
                )
                functions.append({
                    "expression": not declaration,
                    "parameters": None,
                    "ready": False,
                })
            tokens.append(("identifier", value))
            continue
        if char.isdigit() or (
            char == "." and index + 1 < len(source) and source[index + 1].isdigit()
        ):
            number = _NUMBER.match(source, index)
            if number is not None:
                tokens.append(("number", number.group()))
                index = number.end()
                continue
        if source.startswith(("++", "--"), index):
            if _regex_allowed(tokens) is False:
                tokens.append(("postfix", source[index:index + 2]))
            else:
                tokens.append(("punctuation", source[index:index + 2]))
            index += 2
            continue
        if char == "(":
            control = (
                bool(tokens)
                and tokens[-1][0] == "identifier"
                and tokens[-1][1] in _CONTROL_KEYWORDS
            )
            parens.append(control)
            for function in reversed(functions):
                if function["parameters"] is None:
                    function["parameters"] = len(parens)
                    break
            tokens.append(("punctuation", char))
            index += 1
            continue
        if char == ")":
            for function in reversed(functions):
                if function["parameters"] == len(parens):
                    function["ready"] = True
                    break
            control = parens.pop() if parens else False
            tokens.append(
                ("control_close" if control else "punctuation", char)
            )
            index += 1
            continue
        tokens.append(("punctuation", char))
        index += 1
    return tokens, index


def _js_tokens(source, ambiguous_regex=True):
    return _scan_js(source, ambiguous_regex=ambiguous_regex)[0]


def _computed_string_access(tokens, index):
    if index >= len(tokens) or tokens[index][1] != "[":
        return False
    if (
        index + 2 < len(tokens)
        and tokens[index + 1][0] == "string"
        and tokens[index + 2][1] == "]"
    ):
        return True
    if index + 1 >= len(tokens) or tokens[index + 1][0] != "template_start":
        return False
    depth = 0
    for cursor in range(index + 1, len(tokens)):
        kind = tokens[cursor][0]
        if kind == "template_start":
            depth += 1
        elif kind == "template_end":
            depth -= 1
            if depth == 0:
                return (
                    cursor + 1 < len(tokens)
                    and tokens[cursor + 1][1] == "]"
                )
    return False


def _forbidden_regex_names(value):
    names = _FORBIDDEN_REFERENCES | {
        "Function",
        "import",
        "clipboard",
        "sendBeacon",
    }
    return {
        name
        for name in names
        if re.search(
            rf"(?<![A-Za-z0-9_$]){re.escape(name)}(?![A-Za-z0-9_$])",
            value,
        )
    }


def _forbidden_token_findings(tokens):
    findings = set()
    for index, (kind, value) in enumerate(tokens):
        if kind == "regex":
            for name in _forbidden_regex_names(value):
                findings.add(
                    f"{name} (forbidden name inside a regex literal; "
                    "harmless regexes are rejected by design)"
                )
            continue
        if kind != "identifier":
            continue
        previous = tokens[index - 1][1] if index else None
        following = tokens[index + 1][1] if index + 1 < len(tokens) else None
        if value in _FORBIDDEN_REFERENCES:
            findings.add(value)
        elif value == "Function" and (previous == "new" or following == "("):
            findings.add("new Function" if previous == "new" else "Function")
        elif value == "import" and following == "(":
            findings.add("import")
        elif value == "navigator":
            member_index = index + 1
            optional = False
            if (
                member_index + 1 < len(tokens)
                and tokens[member_index][1] == "?"
                and tokens[member_index + 1][1] == "."
            ):
                member_index += 2
                optional = True
            if optional and (
                member_index < len(tokens)
                and tokens[member_index][0] == "identifier"
                and tokens[member_index][1] in {"clipboard", "sendBeacon"}
            ):
                findings.add(f"navigator.{tokens[member_index][1]}")
            elif (
                member_index + 1 < len(tokens)
                and tokens[member_index][1] == "."
                and tokens[member_index + 1][0] == "identifier"
                and tokens[member_index + 1][1] in {"clipboard", "sendBeacon"}
            ):
                findings.add(f"navigator.{tokens[member_index + 1][1]}")
            elif _computed_string_access(tokens, member_index):
                findings.add("navigator[string]")
        elif (
            value in {"window", "globalThis", "self"}
        ):
            member_index = index + 1
            if (
                member_index + 1 < len(tokens)
                and tokens[member_index][1] == "?"
                and tokens[member_index + 1][1] == "."
            ):
                member_index += 2
            if _computed_string_access(tokens, member_index):
                findings.add(f"{value}[string]")
    return findings


def _forbidden_js_apis(source):
    """Return forbidden references, rejecting their names in regexes by design.

    Regex/division context is security-sensitive. Ambiguous closing-brace
    contexts are scanned under both interpretations and their findings are
    combined. A regex body containing a forbidden API name is rejected even
    when the regex is harmless, so a guessed regex can never hide that name.
    """
    findings = set()
    for ambiguous_regex in (True, False):
        findings.update(
            _forbidden_token_findings(
                _js_tokens(source, ambiguous_regex=ambiguous_regex)
            )
        )
    return sorted(findings)


def _visible_literal_at(tokens, index):
    if index >= len(tokens):
        return False
    if tokens[index][0] == "string":
        return any(char.isalpha() for char in tokens[index][1])
    if tokens[index][0] != "template_start":
        return False
    depth = 0
    for kind, value in tokens[index:]:
        if kind == "template_start":
            depth += 1
        elif kind == "template_end":
            depth -= 1
            if depth == 0:
                break
        elif kind == "template_segment" and any(
            char.isalpha() for char in value
        ):
            return True
    return False


def _visible_js_literal_findings(source):
    tokens = _js_tokens(source)
    findings = []
    properties = {
        "textContent",
        "innerText",
        "innerHTML",
        "placeholder",
        "title",
        "alt",
    }
    localized_attributes = {"aria-label", "title", "placeholder", "alt"}
    for index, token in enumerate(tokens):
        if (
            token[1] == "."
            and index + 3 < len(tokens)
            and tokens[index + 1][0] == "identifier"
            and tokens[index + 1][1] in properties
            and tokens[index + 2][1] == "="
            and _visible_literal_at(tokens, index + 3)
        ):
            findings.append(
                f"visible string literal assigned to .{tokens[index + 1][1]}"
            )
        if (
            token == ("identifier", "setAttribute")
            and index + 4 < len(tokens)
            and tokens[index + 1][1] == "("
            and tokens[index + 2][0] == "string"
            and tokens[index + 2][1].lower() in localized_attributes
            and tokens[index + 3][1] == ","
            and _visible_literal_at(tokens, index + 4)
        ):
            findings.append(
                f"visible string literal passed to setAttribute({tokens[index + 2][1]!r})"
            )
    return findings


class _TemplateParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.findings = []
        self.used_keys = set()

    def handle_starttag(self, tag, attrs):
        if tag in {"html", "head", "body", "script", "link", "style"}:
            self.findings.append(f"<{tag}> is forbidden in template.html")
        if "-" in tag and tag not in ALLOWED_CUSTOM:
            self.findings.append(f"custom element <{tag}> is not allowed")
        attributes = {name.lower(): value for name, value in attrs}
        for name, value in attrs:
            name = name.lower()
            if name.lower().startswith("on"):
                self.findings.append(f"inline handler {name} is forbidden")
            if name == "data-rs-t" or name.startswith("data-rs-t-"):
                self.used_keys.add(value or "")
        for name in ("placeholder", "title", "aria-label", "alt"):
            if (
                attributes.get(name)
                and not attributes.get(f"data-rs-t-{name}")
            ):
                self.findings.append(
                    f"localized attribute {name!r} must use data-rs-t-{name}"
                )

    def handle_data(self, data):
        if data.strip():
            self.findings.append(f"visible literal text is forbidden: {data.strip()!r}")


def lint_template(template, strings):
    findings = []
    html = (template.path / "template.html").read_text(encoding="utf-8")
    css_path = template.path / "template.css"
    js_path = template.path / "template.js"
    css = css_path.read_text(encoding="utf-8") if css_path.exists() else ""
    js = js_path.read_text(encoding="utf-8") if js_path.exists() else ""
    joined = "\n".join((html, css, js))
    if re.search(r"(?:https?:|(?<!:)//)", joined, re.I):
        findings.append("external or protocol-relative URL is forbidden")
    if re.search(r"#[0-9a-f]{3,8}\b|\brgb\(|\bhsl\(", css, re.I):
        findings.append("color literals are forbidden in template.css")
    for api in _forbidden_js_apis(js):
        findings.append(f"forbidden API in template.js: {api}")
    findings.extend(_visible_js_literal_findings(js))
    for component in template.components:
        if component not in ALLOWED_CUSTOM:
            findings.append(f"manifest component {component!r} is not allowed")
    parser = _TemplateParser()
    parser.feed(html)
    findings.extend(parser.findings)
    used = set(parser.used_keys)
    used.update(re.findall(r"RS\.t\(\s*[\"']([^\"']+)", js))
    for key in used:
        if key not in template.strings:
            findings.append(f"string key {key!r} is not listed in template.json")
        if key not in strings:
            findings.append(f"string key {key!r} is missing from de.json")
    for key in template.strings:
        if key not in strings:
            findings.append(f"manifest string {key!r} is missing from de.json")
    return findings
