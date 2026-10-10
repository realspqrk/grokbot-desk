"""Validation and generation of grokbot-desk payload envelopes."""
import json
import re
import secrets
from datetime import timedelta, timezone

from .jsonutil import JSONBoundaryError, loads
from .schema import SchemaError, validate
from .timeutil import to_vienna, vienna_now


MAX_PAYLOAD = 2 * 1024 * 1024
RUN_ID_RE = re.compile(
    r"^[0-9]{8}-[0-9]{6}-[a-z0-9-]{1,20}-[0-9a-f]{4}(?:[0-9a-f]{8})?$"
)
BOT_RE = re.compile(r"^[a-z0-9-]{1,40}$")
FIELDS = {
    "schema", "template", "version", "run_id", "bot", "title", "created",
    "expires_minutes", "notify", "data", "identity",
}


class EnvelopeError(ValueError):
    def __init__(self, pointer, message=None):
        if message is None:
            message, pointer = pointer, ""
        self.pointer = pointer
        self.message = message
        super().__init__(f"{pointer or '/'}: {message}")


def generate_run_id(bot="report"):
    now = vienna_now()
    tag = re.sub("[^a-z0-9-]", "-", bot.lower()).strip("-")[:20] or "report"
    return f"{now:%Y%m%d-%H%M%S}-{tag}-{secrets.token_hex(6)}"


def validate_payload_bytes(raw, registry, used_ids=()):
    if len(raw) > MAX_PAYLOAD:
        raise EnvelopeError("", "payload exceeds 2 MB")
    try:
        payload = loads(raw.decode("utf-8"))
    except JSONBoundaryError as error:
        raise EnvelopeError(
            error.pointer, f"invalid JSON: {error.message}"
        ) from error
    except (UnicodeDecodeError, ValueError) as error:
        raise EnvelopeError("", f"invalid JSON: {error}") from error
    return validate_payload(payload, registry, used_ids)


def validate_payload(payload, registry, used_ids=()):
    if not isinstance(payload, dict):
        raise EnvelopeError("", "payload must be an object")
    for field in payload:
        if field not in FIELDS:
            raise EnvelopeError(f"/{field}", "unknown field")
    for field in ("schema", "template", "version", "bot", "title", "created", "data"):
        if field not in payload:
            raise EnvelopeError(f"/{field}", "required field is missing")
    if payload["schema"] != "report-shell/payload@1":
        raise EnvelopeError("/schema", "must equal report-shell/payload@1")
    if not isinstance(payload["template"], str):
        raise EnvelopeError("/template", "must be a string")
    template = registry.get(payload["template"])
    if template is None:
        raise EnvelopeError("/template", "unknown template")
    if type(payload["version"]) is not int or payload["version"] != template.version:
        raise EnvelopeError("/version", f"must equal template version {template.version}")
    if not isinstance(payload["bot"], str) or not BOT_RE.fullmatch(payload["bot"]):
        raise EnvelopeError("/bot", "invalid bot slug")
    if not isinstance(payload["title"], str) or not 1 <= len(payload["title"]) <= 80:
        raise EnvelopeError("/title", "must be 1-80 characters")
    try:
        created = to_vienna(payload["created"])
    except (TypeError, ValueError, OverflowError) as error:
        raise EnvelopeError("/created", "must be ISO 8601 with an offset") from error
    expires = payload.get("expires_minutes", 240)
    if type(expires) is not int or not 5 <= expires <= 10080:
        raise EnvelopeError("/expires_minutes", "must be an integer from 5 to 10080")
    try:
        to_vienna(created.astimezone(timezone.utc) + timedelta(minutes=expires))
    except (ValueError, OverflowError) as error:
        raise EnvelopeError("/expires_minutes", "expiry is outside the supported timestamp range") from error
    run_id = (
        payload["run_id"]
        if "run_id" in payload
        else generate_run_id(payload["bot"])
    )
    if not isinstance(run_id, str) or not RUN_ID_RE.fullmatch(run_id):
        raise EnvelopeError("/run_id", "invalid run id")
    if run_id in used_ids:
        raise EnvelopeError("/run_id", "run id is already used")
    notify = payload.get("notify")
    if "notify" in payload:
        if not isinstance(notify, dict) or set(notify) != {"webhook_url"} or not isinstance(notify["webhook_url"], str):
            raise EnvelopeError("/notify", "must contain only webhook_url")
    try:
        schema = loads(template.read_text("schema.json"))
        validate(payload["data"], schema, "/data")
    except SchemaError as error:
        raise EnvelopeError(error.pointer, error.message) from error
    result = dict(payload)
    result["run_id"] = run_id
    result["expires_minutes"] = expires
    return result
