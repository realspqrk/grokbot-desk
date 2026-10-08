"""Strict RFC 8259 JSON parsing and serialization."""
import json
import math


MAX_JSON_DEPTH = 64


class JSONBoundaryError(ValueError):
    def __init__(self, pointer, message):
        self.pointer = pointer
        self.message = message
        super().__init__(f"{pointer or '/'}: {message}")


def _reject_constant(value):
    raise ValueError(f"non-JSON numeric constant {value}")


def _finite_float(value):
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError(f"non-finite JSON number {value}")
    return parsed


def _pointer(parent, part):
    if isinstance(part, str):
        part = "".join(
            f"\\u{ord(char):04x}" if 0xD800 <= ord(char) <= 0xDFFF else char
            for char in part
        )
    escaped = str(part).replace("~", "~0").replace("/", "~1")
    return f"{parent}/{escaped}"


def _string_end(source, start):
    index = start + 1
    while index < len(source):
        if source[index] == "\\":
            index += 2
            continue
        if source[index] == '"':
            return index + 1
        index += 1
    return len(source)


def _check_nesting(source, max_depth):
    stack = []

    def consume_value():
        if not stack:
            return ""
        parent = stack[-1]
        if parent["kind"] == "array":
            pointer = _pointer(parent["pointer"], parent["index"])
            parent["index"] += 1
            return pointer
        key = parent["key"]
        parent["key"] = None
        return _pointer(parent["pointer"], key if key is not None else "<value>")

    index = 0
    while index < len(source):
        char = source[index]
        if char.isspace() or char in ",:":
            index += 1
            continue
        if char == '"':
            end = _string_end(source, index)
            probe = end
            while probe < len(source) and source[probe].isspace():
                probe += 1
            if stack and stack[-1]["kind"] == "object" and (
                probe < len(source) and source[probe] == ":"
            ):
                try:
                    stack[-1]["key"] = json.loads(source[index:end])
                except (ValueError, RecursionError):
                    pass
            else:
                consume_value()
            index = end
            continue
        if char in "[{":
            pointer = consume_value()
            if len(stack) >= max_depth:
                raise JSONBoundaryError(
                    pointer, f"JSON nesting exceeds {max_depth}"
                )
            stack.append(
                {
                    "kind": "array" if char == "[" else "object",
                    "pointer": pointer,
                    "index": 0,
                    "key": None,
                }
            )
            index += 1
            continue
        if char in "]}":
            if stack:
                stack.pop()
            index += 1
            continue
        consume_value()
        while index < len(source) and source[index] not in ",]}":
            index += 1


def _normalize_string(value, pointer):
    result = []
    index = 0
    while index < len(value):
        codepoint = ord(value[index])
        if 0xD800 <= codepoint <= 0xDBFF:
            if index + 1 >= len(value):
                raise JSONBoundaryError(pointer, "unpaired surrogate in string")
            low = ord(value[index + 1])
            if not 0xDC00 <= low <= 0xDFFF:
                raise JSONBoundaryError(pointer, "unpaired surrogate in string")
            result.append(chr(0x10000 + ((codepoint - 0xD800) << 10) + low - 0xDC00))
            index += 2
            continue
        if 0xDC00 <= codepoint <= 0xDFFF:
            raise JSONBoundaryError(pointer, "unpaired surrogate in string")
        result.append(value[index])
        index += 1
    normalized = "".join(result)
    return value if normalized == value else normalized


def _normalize(value, pointer="", depth=0, max_depth=MAX_JSON_DEPTH):
    if isinstance(value, str):
        return _normalize_string(value, pointer)
    if isinstance(value, list):
        if depth >= max_depth:
            raise JSONBoundaryError(
                pointer, f"JSON nesting exceeds {max_depth}"
            )
        return [
            _normalize(
                item,
                _pointer(pointer, index),
                depth + 1,
                max_depth,
            )
            for index, item in enumerate(value)
        ]
    if isinstance(value, dict):
        if depth >= max_depth:
            raise JSONBoundaryError(
                pointer, f"JSON nesting exceeds {max_depth}"
            )
        result = {}
        for key, item in value.items():
            key_pointer = _pointer(pointer, key)
            normalized_key = _normalize_string(key, key_pointer)
            if normalized_key in result:
                raise JSONBoundaryError(
                    key_pointer, "duplicate object key after Unicode normalization"
                )
            result[normalized_key] = _normalize(
                item,
                _pointer(pointer, normalized_key),
                depth + 1,
                max_depth,
            )
        return result
    return value


def loads(value, *, max_depth=MAX_JSON_DEPTH):
    if isinstance(value, (bytes, bytearray)):
        value = bytes(value).decode("utf-8-sig")
    _check_nesting(value, max_depth)
    try:
        decoded = json.loads(
            value,
            parse_constant=_reject_constant,
            parse_float=_finite_float,
        )
    except RecursionError as error:
        raise JSONBoundaryError("", "JSON nesting exceeds parser limit") from error
    return _normalize(decoded, max_depth=max_depth)


def dumps(value, **kwargs):
    return json.dumps(value, allow_nan=False, **kwargs)
