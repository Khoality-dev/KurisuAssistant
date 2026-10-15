"""Time on the calendar: zones, parsing and the words a person reads.

The database stores instants as naive UTC, like every other column in the
schema, and all-day entries as plain dates. People — and the assistant speaking
for them — write wall-clock time in their own zone, so this is where "19:00 on
the 16th" becomes an instant. Which zone is ``calendar/zone.zone_for``'s
answer; one the server does not know is UTC, never a failure.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timezone
from typing import Optional, Union
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

UTC = ZoneInfo("UTC")

_DATE_ONLY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def is_valid_zone(name: Optional[str]) -> bool:
    """Whether ``name`` is an IANA zone this server can use."""
    if not name or not isinstance(name, str):
        return False
    # ZoneInfo reads a file named after the key; a key that is a path is not a zone.
    if name.startswith("/") or ".." in name or "\\" in name:
        return False
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return False
    return True


def zone(name: Optional[str]) -> ZoneInfo:
    """The account's zone, or UTC when it has none the server knows."""
    return ZoneInfo(name) if is_valid_zone(name) else UTC


def _to_naive_utc(value: datetime) -> datetime:
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def parse_local(value: object, tz: ZoneInfo) -> Union[datetime, date]:
    """What a person wrote, as the database stores it.

    ``2026-10-18`` is a date. ``2026-10-16T19:00`` (or with a space) is wall
    time in ``tz`` and comes back as naive UTC. An explicit offset or ``Z`` is
    taken as written. Anything else raises ``ValueError`` with a sentence the
    caller can show — a model reads it and tries again.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValueError(
            "Give a date like 2026-10-18, or a date and time like 2026-10-16T19:00."
        )
    text = value.strip()
    if _DATE_ONLY.match(text):
        try:
            return date.fromisoformat(text)
        except ValueError:
            raise ValueError(f"{text} is not a real date.") from None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError(
            f"Could not read {text!r} as a time. Use a date and time like 2026-10-16T19:00."
        ) from None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=tz)
    return _to_naive_utc(parsed)


def parse_instant(value: Union[str, datetime]) -> datetime:
    """An instant from the REST API: with its offset, or naive meaning UTC."""
    if isinstance(value, datetime):
        parsed = value
    else:
        parsed = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed
    return _to_naive_utc(parsed)


def to_wire(value: Optional[datetime]) -> Optional[str]:
    """Naive UTC as the clients read it: ISO 8601 with a ``Z``."""
    if value is None:
        return None
    return value.replace(microsecond=0).isoformat() + "Z"


def local(value: datetime, tz: ZoneInfo) -> datetime:
    """A stored instant as wall time in ``tz``."""
    return value.replace(tzinfo=timezone.utc).astimezone(tz)


def format_local(value: datetime, tz: ZoneInfo) -> str:
    """``Fri 16 Oct 2026, 19:00`` — an instant as a person in ``tz`` reads it."""
    wall = local(value, tz)
    return f"{wall:%a} {wall.day} {wall:%b %Y}, {wall:%H:%M}"


def format_date(value: date) -> str:
    """``Sun 18 Oct 2026``."""
    return f"{value:%a} {value.day} {value:%b %Y}"


def format_time(value: datetime, tz: ZoneInfo) -> str:
    """``19:00`` — the clock time alone."""
    return f"{local(value, tz):%H:%M}"

