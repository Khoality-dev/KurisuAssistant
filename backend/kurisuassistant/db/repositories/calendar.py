"""Repository for the user's calendar (#282).

Every read takes a ``user_id`` and filters on it, as the drive's repository
does: the router and the assistant's tools both come through here, so "whose
entry is this" is answered in one place.
"""

from datetime import date, datetime, timedelta
from typing import List, Optional

from sqlalchemy import DateTime, and_, cast, func, or_
from sqlalchemy.orm import Session

from ..models import CalendarEntry
from .base import BaseRepository


class CalendarEntryRepository(BaseRepository[CalendarEntry]):
    def __init__(self, session: Session):
        super().__init__(CalendarEntry, session)

    def get_for_user(self, user_id: int, entry_id: int) -> Optional[CalendarEntry]:
        return self.get_by_filter(user_id=user_id, id=entry_id)

    def in_window(self, user_id: int, start: datetime, end: datetime) -> List[CalendarEntry]:
        """Entries that overlap ``[start, end)``.

        A timed entry overlaps when it starts before the end and finishes (or,
        for a reminder, happens) at or after the start. An all-day entry is a
        range of dates with no zone of its own, so it is matched a day wider on
        each side and the client places it by its own calendar dates — the one
        reading of "18 October" that is right wherever the user is.
        """
        first_day = (start - timedelta(days=1)).date()
        last_day = (end + timedelta(days=1)).date()
        timed = and_(
            CalendarEntry.all_day.is_(False),
            CalendarEntry.starts_at < end,
            func.coalesce(CalendarEntry.ends_at, CalendarEntry.starts_at) >= start,
        )
        all_day = and_(
            CalendarEntry.all_day.is_(True),
            CalendarEntry.start_date <= last_day,
            CalendarEntry.end_date >= first_day,
        )
        return (
            self.session.query(CalendarEntry)
            .filter(CalendarEntry.user_id == user_id, or_(timed, all_day))
            .order_by(
                func.coalesce(CalendarEntry.starts_at, cast(CalendarEntry.start_date, DateTime)),
                CalendarEntry.id,
            )
            .all()
        )

    def upcoming(self, user_id: int, now: datetime, today: date, limit: int) -> List[CalendarEntry]:
        """What is still ahead: events not yet over, reminders not done and not past.

        ``today`` is the user's own date, for all-day events. Ordered by when
        each begins, all-day ones at the start of their day.
        """
        timed_event = and_(
            CalendarEntry.kind == "event",
            CalendarEntry.all_day.is_(False),
            CalendarEntry.ends_at >= now,
        )
        all_day_event = and_(
            CalendarEntry.kind == "event",
            CalendarEntry.all_day.is_(True),
            CalendarEntry.end_date >= today,
        )
        reminder = and_(
            CalendarEntry.kind == "reminder",
            CalendarEntry.done_at.is_(None),
            CalendarEntry.starts_at >= now,
        )
        return (
            self.session.query(CalendarEntry)
            .filter(CalendarEntry.user_id == user_id, or_(timed_event, all_day_event, reminder))
            .order_by(
                func.coalesce(CalendarEntry.starts_at, cast(CalendarEntry.start_date, DateTime)),
                CalendarEntry.id,
            )
            .limit(limit)
            .all()
        )

    def due_reminders(self, now: datetime, limit: int) -> List[CalendarEntry]:
        """Reminders whose time has come and that have not gone out, oldest first."""
        return (
            self.session.query(CalendarEntry)
            .filter(
                CalendarEntry.kind == "reminder",
                CalendarEntry.delivered_at.is_(None),
                CalendarEntry.done_at.is_(None),
                CalendarEntry.starts_at <= now,
            )
            .order_by(CalendarEntry.starts_at, CalendarEntry.id)
            .limit(limit)
            .with_for_update(skip_locked=True)
            .all()
        )
