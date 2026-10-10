"""Small JSON Schema validator for the grokbot-desk template contract."""
import math
import re


KEYWORDS = {
    "type", "properties", "required", "additionalProperties", "items",
    "minItems", "maxItems", "uniqueItems", "enum", "const", "minLength",
    "maxLength", "pattern", "minimum", "maximum", "oneOf", "default",
    "description",
}
# Extension keyword on an array of objects: the named property must not
# repeat across items (e.g. option ids). JSON Schema has no such keyword.
UNIQUE_KEY = "x-rs-unique-key"
TYPES = {
    "object": dict,
    "array": list,
    "string": str,
    "integer": int,
    "number": (int, float),
    "boolean": bool,
    "null": type(None),
}


class SchemaError(ValueError):
    def __init__(self, pointer, message):
        self.pointer = pointer
        self.message = message
        super().__init__(f"{pointer or '/'}: {message}")


def _pointer(parent, part):
    escaped = str(part).replace("~", "~0").replace("/", "~1")
    return f"{parent}/{escaped}"


def _compile_pattern(pattern):
    translated = []
    in_character_class = False
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if char == "\\":
            translated.append(char)
            if index + 1 < len(pattern):
                translated.append(pattern[index + 1])
                index += 2
                continue
            index += 1
            continue
        elif char == "[" and not in_character_class:
            in_character_class = True
        elif char == "]" and in_character_class:
            in_character_class = False
        elif char == "$" and not in_character_class:
            translated.append(r"\Z")
            index += 1
            continue
        translated.append(char)
        index += 1
    return re.compile("".join(translated))


def check_schema(schema, pointer=""):
    if not isinstance(schema, dict):
        raise SchemaError(pointer, "schema node must be an object")
    for key in schema:
        if key not in KEYWORDS and not key.startswith("x-rs-"):
            raise SchemaError(_pointer(pointer, key), f"unsupported schema keyword {key!r}")
    if "type" in schema and (
        not isinstance(schema["type"], str) or schema["type"] not in TYPES
    ):
        raise SchemaError(_pointer(pointer, "type"), "unsupported type")
    if "required" in schema and (
        not isinstance(schema["required"], list)
        or not all(isinstance(item, str) for item in schema["required"])
        or len(schema["required"]) != len(set(schema["required"]))
    ):
        raise SchemaError(_pointer(pointer, "required"), "must be an array of unique strings")
    if "additionalProperties" in schema and not isinstance(schema["additionalProperties"], bool):
        raise SchemaError(_pointer(pointer, "additionalProperties"), "must be a boolean")
    for key in ("minItems", "maxItems", "minLength", "maxLength"):
        if key in schema and (
            not isinstance(schema[key], int) or isinstance(schema[key], bool) or schema[key] < 0
        ):
            raise SchemaError(_pointer(pointer, key), "must be a non-negative integer")
    for key in ("minimum", "maximum"):
        if key in schema and (
            not isinstance(schema[key], (int, float)) or isinstance(schema[key], bool)
            or (
                isinstance(schema[key], float)
                and not math.isfinite(schema[key])
            )
        ):
            raise SchemaError(_pointer(pointer, key), "must be a number")
    if "uniqueItems" in schema and not isinstance(schema["uniqueItems"], bool):
        raise SchemaError(_pointer(pointer, "uniqueItems"), "must be a boolean")
    if UNIQUE_KEY in schema:
        if not isinstance(schema[UNIQUE_KEY], str) or not schema[UNIQUE_KEY]:
            raise SchemaError(_pointer(pointer, UNIQUE_KEY), "must be a non-empty property name")
        if schema.get("type", "array") != "array":
            raise SchemaError(_pointer(pointer, UNIQUE_KEY), "only applies to arrays")
    if "enum" in schema and (not isinstance(schema["enum"], list) or not schema["enum"]):
        raise SchemaError(_pointer(pointer, "enum"), "must be a non-empty array")
    if "pattern" in schema:
        if not isinstance(schema["pattern"], str):
            raise SchemaError(_pointer(pointer, "pattern"), "must be a string")
        try:
            _compile_pattern(schema["pattern"])
        except re.error as error:
            raise SchemaError(_pointer(pointer, "pattern"), f"invalid pattern: {error}") from error
    if "description" in schema and not isinstance(schema["description"], str):
        raise SchemaError(_pointer(pointer, "description"), "must be a string")
    if "minItems" in schema and "maxItems" in schema and schema["minItems"] > schema["maxItems"]:
        raise SchemaError(pointer, "minItems cannot exceed maxItems")
    if "minLength" in schema and "maxLength" in schema and schema["minLength"] > schema["maxLength"]:
        raise SchemaError(pointer, "minLength cannot exceed maxLength")
    for key in ("properties",):
        if key in schema:
            if not isinstance(schema[key], dict):
                raise SchemaError(_pointer(pointer, key), "must be an object")
            for name, child in schema[key].items():
                check_schema(child, _pointer(_pointer(pointer, key), name))
    if "items" in schema:
        check_schema(schema["items"], _pointer(pointer, "items"))
    if "oneOf" in schema:
        if not isinstance(schema["oneOf"], list) or not schema["oneOf"]:
            raise SchemaError(_pointer(pointer, "oneOf"), "must be a non-empty array")
        for index, child in enumerate(schema["oneOf"]):
            check_schema(child, _pointer(_pointer(pointer, "oneOf"), index))


def _matches_type(value, expected):
    if expected == "integer":
        return (
            isinstance(value, int)
            and not isinstance(value, bool)
        ) or (
            isinstance(value, float)
            and math.isfinite(value)
            and value.is_integer()
        )
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return isinstance(value, TYPES.get(expected, ()))


def _json_equal(left, right):
    left_number = isinstance(left, (int, float)) and not isinstance(left, bool)
    right_number = isinstance(right, (int, float)) and not isinstance(right, bool)
    if left_number or right_number:
        return left_number and right_number and left == right
    if isinstance(left, list) or isinstance(right, list):
        return (
            isinstance(left, list)
            and isinstance(right, list)
            and len(left) == len(right)
            and all(_json_equal(a, b) for a, b in zip(left, right))
        )
    if isinstance(left, dict) or isinstance(right, dict):
        return (
            isinstance(left, dict)
            and isinstance(right, dict)
            and left.keys() == right.keys()
            and all(_json_equal(left[key], right[key]) for key in left)
        )
    return type(left) is type(right) and left == right


def _check_unique_key(items, key, pointer):
    seen = []
    for index, item in enumerate(items):
        if not isinstance(item, dict) or key not in item:
            continue
        for first, previous in seen:
            if _json_equal(item[key], previous):
                raise SchemaError(
                    _pointer(_pointer(pointer, index), key),
                    f"duplicate {key} {item[key]!r}, already used by {_pointer(pointer, first)}",
                )
        seen.append((index, item[key]))


def validate(value, schema, pointer=""):
    check_schema(schema)
    if isinstance(value, float) and not math.isfinite(value):
        raise SchemaError(pointer, "number must be finite")
    if "oneOf" in schema:
        matches = 0
        errors = []
        for option in schema["oneOf"]:
            try:
                validate(value, option, pointer)
                matches += 1
            except SchemaError as error:
                errors.append(error)
        if matches == 0:
            useful = [error for error in errors if error.pointer != pointer]
            if useful:
                raise max(
                    useful,
                    key=lambda error: (
                        error.pointer.count("/"),
                        len(error.pointer),
                    ),
                )
            raise SchemaError(pointer, "must match exactly one oneOf option (matched 0)")
        if matches != 1:
            raise SchemaError(pointer, f"must match exactly one oneOf option (matched {matches})")
    if "type" in schema and not _matches_type(value, schema["type"]):
        raise SchemaError(pointer, f"expected {schema['type']}")
    if "const" in schema and not _json_equal(value, schema["const"]):
        raise SchemaError(pointer, f"must equal {schema['const']!r}")
    if "enum" in schema and not any(_json_equal(value, item) for item in schema["enum"]):
        raise SchemaError(pointer, f"must be one of {schema['enum']!r}")
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        for name in schema.get("required", []):
            if name not in value:
                raise SchemaError(_pointer(pointer, name), "required property is missing")
        if schema.get("additionalProperties") is False:
            for name in value:
                if name not in properties:
                    raise SchemaError(_pointer(pointer, name), "unknown property")
        for name, child in properties.items():
            if name in value:
                validate(value[name], child, _pointer(pointer, name))
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            raise SchemaError(pointer, f"must contain at least {schema['minItems']} items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            raise SchemaError(pointer, f"must contain at most {schema['maxItems']} items")
        if schema.get("uniqueItems"):
            for index, item in enumerate(value):
                if any(_json_equal(item, previous) for previous in value[:index]):
                    raise SchemaError(pointer, "items must be unique")
        if "items" in schema:
            for index, item in enumerate(value):
                validate(item, schema["items"], _pointer(pointer, index))
        if UNIQUE_KEY in schema:
            _check_unique_key(value, schema[UNIQUE_KEY], pointer)
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            raise SchemaError(pointer, f"must be at least {schema['minLength']} characters")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            raise SchemaError(pointer, f"must be at most {schema['maxLength']} characters")
        if "pattern" in schema and _compile_pattern(schema["pattern"]).search(value) is None:
            raise SchemaError(pointer, f"must match pattern {schema['pattern']!r}")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            raise SchemaError(pointer, f"must be at least {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            raise SchemaError(pointer, f"must be at most {schema['maximum']}")
    return value
