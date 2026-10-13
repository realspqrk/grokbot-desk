"""Timestamps in the local time zone of this machine.

The person and the desk share one machine, so "today", a due time and every
result timestamp use its time zone. RS_TZ (an IANA name such as
Europe/Vienna) pins one zone instead, for tests and screenshots. Without
time zone data (Windows has none in the standard library) a pinned Central
European zone falls back to the EU daylight saving rule, and any other
pinned zone to the machine's own.

Tests may set RS_CLOCK_ANCHOR to an ISO 8601 instant with an offset. The
process clock then starts at that instant and advances with monotonic time.
"""
import os
import re
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo


WEEKDAYS = ("Mo", "Di", "Mi", "Do", "Fr", "Sa", "So")
ZONE_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+){0,2}$")
# Central European zones: UTC+1, UTC+2 in summer (EU rule)
EU_CENTRAL = frozenset(
    "Europe/" + city
    for city in (
        "Amsterdam Andorra Belgrade Berlin Bratislava Brussels Budapest Copenhagen Gibraltar "
        "Ljubljana Luxembourg Madrid Malta Monaco Oslo Paris Podgorica Prague Rome San_Marino "
        "Sarajevo Skopje Stockholm Tirane Vaduz Vatican Vienna Warsaw Zagreb Zurich"
    ).split()
)
UTC_NAMES = frozenset({"UTC", "Etc/UTC", "Etc/GMT", "GMT"})


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


def zone_name():
    """The pinned IANA zone (RS_TZ), or None for the machine's own zone."""
    name = os.environ.get("RS_TZ", "").strip()
    return name if ZONE_NAME.fullmatch(name) else None


def to_local(value):
    utc = _parse(value).astimezone(timezone.utc)
    name = zone_name()
    if name:
        try:
            return utc.astimezone(ZoneInfo(name))
        except Exception:
            if name in EU_CENTRAL:
                return utc.astimezone(timezone(_fallback_offset(utc), name))
            if name in UTC_NAMES:
                return utc
    return utc.astimezone()


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


def local_now():
    if _CLOCK_ANCHOR is None:
        now = datetime.now(timezone.utc)
    else:
        anchor, started = _CLOCK_ANCHOR
        now = anchor + timedelta(seconds=time.monotonic() - started)
    return to_local(now)


def iso_now():
    return local_now().isoformat(timespec="seconds")


def format_local(value):
    local = to_local(value)
    return f"{WEEKDAYS[local.weekday()]} {local:%d.%m.%Y} · {local:%H:%M}"
