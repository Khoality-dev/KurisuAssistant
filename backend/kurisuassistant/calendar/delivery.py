"""A reminder's notification: sent when it is due, read when it is handled (#353).

This is the calendar's only way out to the user's devices, and it is the seam
the tests patch: ``workers/reminders.py`` calls ``delivery.deliver`` through
the module, never a name it imported. ``kurisuassistant.notifications`` is
imported at call time, so importing the calendar does not import it.
"""

import logging
from datetime import datetime
from typing import Any, Dict

logger = logging.getLogger(__name__)


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


async def withdraw(user_id: int, entry_id: int) -> None:
    """Read the notification of a reminder the user has dealt with, on every device.

    Called when a reminder is done, moved or deleted, from the REST routes and
    from the assistant's tools alike, so a phone is not left asking about
    something already handled; a moved reminder notifies again at its new time.
    Nothing to read is not an error. Never raises: the change it follows is
    already committed.
    """
    from kurisuassistant.notifications import mark_read

    try:
        await mark_read(user_id, reminder_id=entry_id)
    except Exception:
        logger.error("Could not read the notification of reminder %s for user %s", entry_id, user_id, exc_info=True)


def due_text(starts_at: datetime, time_zone, now: datetime = None) -> str:
    """``Due at 19:00`` — or the whole date when it is not today any more,
    which is what a reminder delivered late (the server was down) says."""
    from kurisuassistant.calendar import times

    tz = times.zone(time_zone)
    now = now or datetime.utcnow()
    if times.local(starts_at, tz).date() == times.local(now, tz).date():
        return f"Due at {times.format_time(starts_at, tz)}"
    return f"Was due {times.format_local(starts_at, tz)}"
