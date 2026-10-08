"""Europe/Vienna timestamps with a built-in EU DST fallback.

Tests may set RS_CLOCK_ANCHOR to an ISO 8601 instant with an offset. The
process clock then starts at that instant and advances with monotonic time.
"""
import os
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo


WEEKDAYS = ("Mo", "Di", "Mi", "Do", "Fr", "Sa", "So")


def _last_sunday(year, month):
    if month == 12:
        first_next = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        first_next = datetime(year, month + 1, 1, tzinfo=timezone.utc)
    day = first_next - timedelta(days=1)
    return day - timedelta(days=(day.weekday() + 1) % 7)


def _fallback_offset(utc):
    start = _last_sunday(utc.year, 3).replace(hour=1)
    end = _last_sunday(utc.year, 10).replace(hour=1)
    return timedelta(hours=2 if start <= utc < end else 1)


def _parse(value):
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        parsed = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
    else:
        raise TypeError("timestamp must be a string or datetime")
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("timestamp must include an offset")
    return parsed


def to_vienna(value):
    parsed = _parse(value)
    utc = parsed.astimezone(timezone.utc)
    try:
        return utc.astimezone(ZoneInfo("Europe/Vienna"))
    except Exception:
        return utc.astimezone(timezone(_fallback_offset(utc), "Europe/Vienna"))


def _read_clock_anchor():
    value = os.environ.get("RS_CLOCK_ANCHOR")
    if value is None:
        return None
    try:
        anchor = _parse(value).astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError) as error:
        raise RuntimeError(
            "RS_CLOCK_ANCHOR must be an ISO 8601 instant with an offset"
        ) from error
    return anchor, time.monotonic()


_CLOCK_ANCHOR = _read_clock_anchor()


def vienna_now():
    if _CLOCK_ANCHOR is None:
        now = datetime.now(timezone.utc)
    else:
        anchor, started = _CLOCK_ANCHOR
        now = anchor + timedelta(seconds=time.monotonic() - started)
    return to_vienna(now)


def iso_now():
    return vienna_now().isoformat(timespec="seconds")


def format_vienna(value):
    local = to_vienna(value)
    return f"{WEEKDAYS[local.weekday()]} {local:%d.%m.%Y} · {local:%H:%M}"
