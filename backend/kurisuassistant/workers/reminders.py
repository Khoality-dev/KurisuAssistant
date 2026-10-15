"""The due-reminder scanner (#282).

Every ``REMINDER_SCAN_INTERVAL_SECONDS`` it finds calendar reminders whose time
has come, claims each by stamping ``delivered_at`` in the same transaction that
found it, and hands it to ``calendar.delivery.deliver``. A reminder therefore
goes out once: a second scan does not see a claimed row, and moving a reminder
is the only thing that clears the stamp (``calendar/entries.apply_update``).

A delivery that raises is not lost and not repeated forever. The claim is
released and ``delivery_attempts`` bumped, so the next scan tries again; after
``MAX_DELIVERY_ATTEMPTS`` the stamp stays and the failure is logged as an
error — the reminder is still on the calendar, it just never notified.

This runs as an asyncio task on the app's own event loop rather than on a
worker thread like the scanners in ``service.py``: delivery reaches the
clients' open connections (#353), which live on that loop. The database work
still goes through the single DB thread.

Nothing here starts the assistant. A reminder notifies the user; work the
assistant does on a schedule is a task (#352).
"""

import asyncio
import logging
from datetime import datetime
from typing import Optional

logger = logging.getLogger(__name__)

REMINDER_SCAN_INTERVAL_SECONDS = 30
#: Reminders claimed per scan; the rest wait half a minute.
SCAN_LIMIT = 100
MAX_DELIVERY_ATTEMPTS = 5


async def scan_once(now: Optional[datetime] = None) -> int:
    """Deliver every reminder due by ``now``. Returns how many went out."""
    from kurisuassistant.calendar import delivery, zone
    from kurisuassistant.db.models import User
    from kurisuassistant.db.repositories import CalendarEntryRepository
    from kurisuassistant.db.service import get_db_service

    now = now or datetime.utcnow()
    db = get_db_service()

    def _claim(session):
        rows = CalendarEntryRepository(session).due_reminders(now, SCAN_LIMIT)
        zones = {}
        claimed = []
        for row in rows:
            row.delivered_at = now
            if row.user_id not in zones:
                user = session.get(User, row.user_id)
                zones[row.user_id] = zone.zone_for(user).key
            claimed.append({
                "id": row.id,
                "user_id": row.user_id,
                "title": row.title,
                "starts_at": row.starts_at,
                "time_zone": zones[row.user_id],
            })
        return claimed

    claimed = await db.execute(_claim)
    sent = 0
    for entry in claimed:
        try:
            await delivery.deliver(entry)
        except Exception as exc:
            await _release(entry["id"], exc)
        else:
            sent += 1
    return sent


async def _release(entry_id: int, exc: Exception) -> None:
    """Give a failed claim back for the next scan — or give up on it."""
    from kurisuassistant.db.models import CalendarEntry
    from kurisuassistant.db.service import get_db_service

    def _undo(session):
        row = session.get(CalendarEntry, entry_id)
        if row is None:
            return None
        row.delivery_attempts = (row.delivery_attempts or 0) + 1
        if row.delivery_attempts < MAX_DELIVERY_ATTEMPTS:
            row.delivered_at = None
        return row.delivery_attempts

    attempts = await get_db_service().execute(_undo)
    if attempts is None:
        return
    if attempts >= MAX_DELIVERY_ATTEMPTS:
        logger.error(
            "Reminder %d could not be delivered after %d attempts (%s); giving up",
            entry_id, attempts, exc, exc_info=exc,
        )
    else:
        logger.warning(
            "Reminder %d could not be delivered (attempt %d/%d): %s; trying again next scan",
            entry_id, attempts, MAX_DELIVERY_ATTEMPTS, exc,
        )


class ReminderScanner:
    """Runs :func:`scan_once` on the app's event loop until stopped."""

    def __init__(self):
        self._task: Optional[asyncio.Task] = None
        self._stopping: Optional[asyncio.Event] = None

    def start(self) -> bool:
        """Start on the running loop. Without one (a script, a test calling
        ``workers.start()`` outside the app) there is nothing to run on."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            logger.info("No running event loop; the reminder scanner is not started")
            return False
        self._stopping = asyncio.Event()
        self._task = loop.create_task(self._run(), name="reminder-scanner")
        logger.info("Reminder scanner started (interval=%ds)", REMINDER_SCAN_INTERVAL_SECONDS)
        return True

    def stop(self) -> None:
        if self._task is None:
            return
        self._stopping.set()
        self._task.cancel()
        self._task = None
        logger.info("Reminder scanner stopped")

    async def _run(self) -> None:
        while not self._stopping.is_set():
            try:
                await asyncio.wait_for(self._stopping.wait(), timeout=REMINDER_SCAN_INTERVAL_SECONDS)
                break
            except asyncio.TimeoutError:
                pass
            try:
                await scan_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.error("Reminder scanner error", exc_info=True)
