"""Validation and generation of grokbot-desk payload@2 envelopes.

The envelope carries who sends the report, when, what it asks for and its
dedupe and expiry settings; the blocks and the ask's decision contract are
checked by core/payload.py.
"""
import copy
import re
import secrets
from datetime import date, timedelta, timezone

from .jsonutil import JSONBoundaryError, loads
from .payload import EnvelopeError, validate_blocks, with_ids
from .timeutil import to_local, local_now
from .why import why_warnings


__all__ = [
    "EnvelopeError", "MAX_PAYLOAD", "RUN_ID_RE", "SCHEMA", "generate_run_id",
    "validate_payload", "validate_payload_bytes",
]

SCHEMA = "grokbot-desk/payload@2"
SCHEMA_MESSAGE = f"must equal {SCHEMA} (payload@1 and templates were removed; see SKILL.md)"
MAX_PAYLOAD = 2 * 1024 * 1024
RUN_ID_RE = re.compile(
    r"^[0-9]{8}-[0-9]{6}-[a-z0-9-]{1,20}-[0-9a-f]{4}(?:[0-9a-f]{8})?$"
)
BOT_RE = re.compile(r"^[a-z0-9-]{1,40}$")
FIELDS = {
    "schema", "bot", "identity", "title", "created", "why", "ask", "action",
    "label", "due", "urgent", "expires_minutes", "dedupe_key", "dedupe_hours",
    "run_id", "blocks",
}
REQUIRED = ("bot", "title", "created", "ask", "blocks")
DEDUPE_KEY_RE = re.compile(r"^[\x21-\x7e][\x20-\x7e]{0,119}$")
# one line of 1-24 characters with no space at either end (action, label)
SHORT_LINE_RE = re.compile(r"^[^\s\x00-\x1f\x7f](?:[^\x00-\x1f\x7f]*[^\s\x00-\x1f\x7f])?$")
DATE_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
# What Edge parses: a calendar date, or an extended timestamp with Z or ±HH:MM.
# Basic ISO, week dates and odd separators parse in Python and then vanish in the browser.
EXTENDED_DUE = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}"
    r"(?::[0-9]{2}(?:\.[0-9]{1,3})?)?(?:Z|[+-][0-9]{2}:[0-9]{2})$"
)
# A created stamp this far ahead of the clock is a wrong offset or clock: it
# is clamped to now (the result's duration_s would read 0 otherwise).
MAX_CREATED_AHEAD = timedelta(minutes=2)


def generate_run_id(bot="report"):
    now = local_now()
    tag = re.sub("[^a-z0-9-]", "-", bot.lower()).strip("-")[:20] or "report"
    return f"{now:%Y%m%d-%H%M%S}-{tag}-{secrets.token_hex(6)}"


def validate_payload_bytes(raw, used_ids=(), warnings=None):
    if len(raw) > MAX_PAYLOAD:
        raise EnvelopeError("", "payload exceeds 2 MB")
    try:
        # one leading BOM (PowerShell's UTF-8) is stripped, as on the CLI path
        payload = loads(raw.decode("utf-8-sig"))
    except JSONBoundaryError as error:
        raise EnvelopeError(
            error.pointer, f"invalid JSON: {error.message}"
        ) from error
    except (UnicodeDecodeError, ValueError) as error:
        raise EnvelopeError("", f"invalid JSON: {error}") from error
    return validate_payload(payload, used_ids, warnings)


def _short_line(payload, field):
    value = payload[field]
    if not isinstance(value, str) or not 1 <= len(value) <= 24 or not SHORT_LINE_RE.fullmatch(value):
        raise EnvelopeError(
            f"/{field}", "must be 1-24 characters on one line, without spaces at either end"
        )


def _check_due(due):
    try:
        if not isinstance(due, str):
            raise ValueError
        if DATE_RE.fullmatch(due):
            date.fromisoformat(due)
        elif EXTENDED_DUE.fullmatch(due):
            to_local(due)
        else:
            raise ValueError
    except (TypeError, ValueError, OverflowError) as error:
        raise EnvelopeError(
            "/due",
            "must be YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS[.fff]]Z or with a ±HH:MM offset",
        ) from error


def validate_payload(payload, used_ids=(), warnings=None):
    """The payload with every block id filled, run_id and expires_minutes set.

    Raises EnvelopeError(pointer, message). The input is not changed.
    """
    if not isinstance(payload, dict):
        raise EnvelopeError("", "payload must be an object")
    if "schema" not in payload:
        raise EnvelopeError("/schema", "required field is missing")
    if payload["schema"] != SCHEMA:
        raise EnvelopeError("/schema", SCHEMA_MESSAGE)
    for field in payload:
        if field not in FIELDS:
            raise EnvelopeError(f"/{field}", "unknown field")
    for field in REQUIRED:
        if field not in payload:
            raise EnvelopeError(f"/{field}", "required field is missing")
    if not isinstance(payload["bot"], str) or not BOT_RE.fullmatch(payload["bot"]):
        raise EnvelopeError("/bot", "invalid bot slug")
    if not isinstance(payload["title"], str) or not 1 <= len(payload["title"]) <= 80:
        raise EnvelopeError("/title", "must be 1-80 characters")
    try:
        created = to_local(payload["created"])
    except (TypeError, ValueError, OverflowError) as error:
        raise EnvelopeError("/created", "must be ISO 8601 with an offset") from error
    if "why" in payload and (not isinstance(payload["why"], str) or not payload["why"].strip()):
        raise EnvelopeError("/why", "must be a non-empty string")
    for field in ("action", "label"):
        if field in payload:
            _short_line(payload, field)
    if "due" in payload:
        _check_due(payload["due"])
    if "urgent" in payload and not isinstance(payload["urgent"], bool):
        raise EnvelopeError("/urgent", "must be a boolean")
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
    validate_blocks(payload)
    if warnings is not None:
        warnings.extend(why_warnings(payload.get("why")))
    result = copy.deepcopy(payload)
    result["blocks"] = with_ids(result["blocks"])
    if clamped is not None:
        result["created"] = clamped
    result["run_id"] = run_id
    result["expires_minutes"] = expires
    return result
