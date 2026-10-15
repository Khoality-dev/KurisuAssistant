"""The one place the calendar asks which zone a user is in.

Every zone lookup in the calendar — the tools reading "19:00 on Friday", the
"Coming up" list's today, a reminder's "Due at 19:00" — goes through
:func:`zone_for`, which is the account's zone setting (#352,
``core/timezone.py::user_timezone``): UTC for an account that has none.
"""

from zoneinfo import ZoneInfo

from kurisuassistant.core.timezone import UTC, user_timezone

__all__ = ["UTC", "zone_for"]


def zone_for(user) -> ZoneInfo:
    """The zone ``user`` reads the calendar in."""
    return user_timezone(user)
