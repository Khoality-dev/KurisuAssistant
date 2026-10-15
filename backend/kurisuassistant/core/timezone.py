"""The account's time zone: one IANA name per account, read in one place.

The server has no clock on anyone's wall. Each client fills ``users.timezone``
from its device the first time it is empty, and the user can change it in
account settings. Anything that turns a wall time ("07:30", "Friday 19:00") into
a moment asks :func:`user_timezone` — tasks (#352), and the calendar (#282) —
and the system prompt's "Current time" line is the user's clock in it.
"""

from datetime import datetime, timezone as dt_timezone
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

UTC = ZoneInfo("UTC")


def parse_timezone(name: Optional[str]) -> str:
    """The IANA name, trimmed. Raises ``ValueError`` naming anything else."""
    text = (name or "").strip()
    if not text or text.startswith(("+", "-")) or "/" not in text and text != "UTC":
        raise ValueError(f"'{text}' is not a time zone. Use an IANA name such as Europe/Paris.")
    try:
        ZoneInfo(text)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError(f"'{text}' is not a time zone. Use an IANA name such as Europe/Paris.") from None
    return text


def user_timezone_name(user) -> str:
    """The account's zone name, or ``UTC`` when it has none (or one no longer known)."""
    name = getattr(user, "timezone", None) if user is not None else None
    try:
        return parse_timezone(name) if name else "UTC"
    except ValueError:
        return "UTC"


def user_timezone(user) -> ZoneInfo:
    """The account's zone as a ``ZoneInfo``; UTC when it has none."""
    return ZoneInfo(user_timezone_name(user))


def local_time_label(zone: ZoneInfo, now: Optional[datetime] = None) -> str:
    """The user's wall clock, as the system prompt states it.

    "Friday 16 October 2026, 18:42 (Europe/Paris)": the weekday and date are the
    user's, so "tomorrow" means their tomorrow. ``now`` is naive UTC (defaults to
    the present).
    """
    moment = (now or datetime.utcnow()).replace(tzinfo=dt_timezone.utc).astimezone(zone)
    return f"{moment.strftime('%A')} {moment.day} {moment.strftime('%B %Y, %H:%M')} ({zone.key})"
