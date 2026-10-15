"""One due reminder, handed to the notifications module (#353).

This is the calendar's only way out to the user's devices, and it is the seam
the tests patch: ``workers/reminders.py`` calls ``delivery.deliver`` through
the module, never a name it imported. ``kurisuassistant.notifications`` is
imported here, at call time, so the calendar does not depend on it at import —
it is built and shipped by #353.
"""

from datetime import datetime
from typing import Any, Dict


async def deliver(entry: Dict[str, Any]) -> None:
    """Notify the user that ``entry`` — a reminder snapshot — is due.

    ``entry`` carries ``id``, ``user_id``, ``title``, ``starts_at`` (naive UTC)
    and ``time_zone`` (the account's, already resolved). Raises whatever the
    notifications module raises; the scanner decides whether to try again.
    """
    from kurisuassistant.notifications import notify

    await notify(
        entry["user_id"],
        source="calendar",
        title=entry["title"],
        body=due_text(entry["starts_at"], entry.get("time_zone")),
        reminder_id=entry["id"],
    )


def due_text(starts_at: datetime, time_zone, now: datetime = None) -> str:
    """``Due at 19:00`` — or the whole date when it is not today any more,
    which is what a reminder delivered late (the server was down) says."""
    from kurisuassistant.calendar import times

    tz = times.zone(time_zone)
    now = now or datetime.utcnow()
    if times.local(starts_at, tz).date() == times.local(now, tz).date():
        return f"Due at {times.format_time(starts_at, tz)}"
    return f"Was due {times.format_local(starts_at, tz)}"
