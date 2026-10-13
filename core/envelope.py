"""Validation and generation of grokbot-desk payload envelopes."""
import json
import re
import secrets
from datetime import timedelta, timezone

from .jsonutil import JSONBoundaryError, loads
from .rules import check_data
from .schema import SchemaError, validate
from .tasks import TaskError, apply_kind, validate_task
from .timeutil import to_local, local_now


MAX_PAYLOAD = 2 * 1024 * 1024
RUN_ID_RE = re.compile(
    r"^[0-9]{8}-[0-9]{6}-[a-z0-9-]{1,20}-[0-9a-f]{4}(?:[0-9a-f]{8})?$"
)
BOT_RE = re.compile(r"^[a-z0-9-]{1,40}$")
FIELDS = {
    "schema", "template", "version", "run_id", "bot", "title", "created",
    "expires_minutes", "notify", "data", "identity", "dedupe_key", "dedupe_hours",
    "task",
}
DEDUPE_KEY_RE = re.compile(r"^[\x21-\x7e][\x20-\x7e]{0,119}$")
# A created stamp this far ahead of the clock is a wrong offset or clock: it
# is clamped to now (the result's duration_s would read 0 otherwise).
MAX_CREATED_AHEAD = timedelta(minutes=2)


class EnvelopeError(ValueError):
    def __init__(self, pointer, message=None):
        if message is None:
            message, pointer = pointer, ""
        self.pointer = pointer
        self.message = message
        super().__init__(f"{pointer or '/'}: {message}")


def generate_run_id(bot="report"):
    now = local_now()
    tag = re.sub("[^a-z0-9-]", "-", bot.lower()).strip("-")[:20] or "report"
    return f"{now:%Y%m%d-%H%M%S}-{tag}-{secrets.token_hex(6)}"


def validate_payload_bytes(raw, registry, used_ids=(), warnings=None):
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
    return validate_payload(payload, registry, used_ids, warnings)


def validate_payload(payload, registry, used_ids=(), warnings=None):
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
        created = to_local(payload["created"])
    except (TypeError, ValueError, OverflowError) as error:
        raise EnvelopeError("/created", "must be ISO 8601 with an offset") from error
    if "dedupe_key" in payload and (
        not isinstance(payload["dedupe_key"], str)
        or not DEDUPE_KEY_RE.fullmatch(payload["dedupe_key"])
    ):
        raise EnvelopeError("/dedupe_key", "must be 1-120 printable ASCII characters")
    dedupe_hours = payload.get("dedupe_hours", 24)
    if type(dedupe_hours) is not int or not 1 <= dedupe_hours <= 168:
        raise EnvelopeError("/dedupe_hours", "must be an integer from 1 to 168")
    if "dedupe_hours" in payload and "dedupe_key" not in payload:
        raise EnvelopeError("/dedupe_hours", "needs dedupe_key")
    expires = payload.get("expires_minutes", 240)
    if type(expires) is not int or not 5 <= expires <= 10080:
        raise EnvelopeError("/expires_minutes", "must be an integer from 5 to 10080")
    try:
        to_local(created.astimezone(timezone.utc) + timedelta(minutes=expires))
    except (ValueError, OverflowError) as error:
        raise EnvelopeError("/expires_minutes", "expiry is outside the supported timestamp range") from error
    now = local_now()
    clamped = None
    if created.astimezone(timezone.utc) - now.astimezone(timezone.utc) > MAX_CREATED_AHEAD:
        clamped = now.isoformat(timespec="seconds")
        if warnings is not None:
            warnings.append(
                f"/created: {payload['created']} is more than 2 minutes in the future "
                f"(check the UTC offset); clamped to {clamped}"
            )
        created = now
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
        check_data(template.extends or template.id, payload["data"], "/data")
    except SchemaError as error:
        raise EnvelopeError(error.pointer, error.message) from error
    data = payload["data"]
    if "task" in payload:
        try:
            validate_task(payload["task"])
            data = apply_kind(template.extends or template.id, data, payload["task"]["kind"])
            validate(data, schema, "/data")
        except (TaskError, SchemaError) as error:
            raise EnvelopeError(error.pointer, error.message) from error
        if warnings is not None:
            from .tasks import why_warnings
            why = payload["task"].get("why") if isinstance(payload["task"], dict) else None
            warnings.extend(why_warnings(why))
    result = dict(payload)
    result["data"] = data
    if clamped is not None:
        result["created"] = clamped
    result["run_id"] = run_id
    result["expires_minutes"] = expires
    return result
