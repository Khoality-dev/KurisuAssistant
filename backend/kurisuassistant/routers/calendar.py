"""The user's calendar (#282): events and reminders over REST.

Both clients' Calendar screens read and write here; the assistant reaches the
same rows through its calendar tools (``tools/calendar.py``), and both go
through ``calendar/entries.validate`` so the two cannot disagree about what an
entry may be. An entry of another account is 404, never 403 — the drive's rule.

Instants travel as ISO 8601 UTC with a ``Z``; an all-day entry is a pair of
dates with no zone. Nothing here starts the assistant: a due reminder only
notifies the user (``workers/reminders.py``).
"""

import logging
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel

from kurisuassistant.calendar import delivery, entries, times, zone
from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.core.errors import internal_error
from kurisuassistant.db.models import User
from kurisuassistant.db.repositories import CalendarEntryRepository
from kurisuassistant.db.service import get_db_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/calendar", tags=["calendar"])

#: "Coming up" never needs more than a screenful.
MAX_UPCOMING = 100


class EntryCreate(BaseModel):
    kind: str
    title: str
    notes: Optional[str] = None
    all_day: bool = False
    starts_at: Optional[datetime] = None
    ends_at: Optional[datetime] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None


class EntryUpdate(BaseModel):
    """Only the fields sent change. ``done`` is a reminder's alone."""

    title: Optional[str] = None
    notes: Optional[str] = None
    all_day: Optional[bool] = None
    starts_at: Optional[datetime] = None
    ends_at: Optional[datetime] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    done: Optional[bool] = None


def _instant(value: Optional[datetime]) -> Optional[datetime]:
    return times.parse_instant(value) if value is not None else None


class _NotFound(LookupError):
    """No entry of this account by that id — a refusal, not a failure."""


@router.get("/entries")
async def list_entries(
    start: datetime = Query(...),
    end: datetime = Query(...),
    user: User = Depends(get_authenticated_user),
):
    """Every entry overlapping ``[start, end)`` — what a day or week view shows."""
    start_utc, end_utc = times.parse_instant(start), times.parse_instant(end)
    if end_utc <= start_utc:
        raise HTTPException(status_code=400, detail="The window must end after it starts.")
    if end_utc - start_utc > entries.MAX_WINDOW:
        raise HTTPException(status_code=400, detail="Ask for at most a year at a time.")
    try:
        def _list(session):
            rows = CalendarEntryRepository(session).in_window(user.id, start_utc, end_utc)
            return [entries.to_response(r) for r in rows]

        return await get_db_service().execute(_list)
    except Exception as e:
        raise internal_error(e, "Error reading the calendar")


@router.get("/upcoming")
async def upcoming(
    limit: int = Query(20, ge=1, le=MAX_UPCOMING),
    user: User = Depends(get_authenticated_user),
):
    """What is still ahead, soonest first: the "Coming up" list."""
    now = datetime.utcnow()
    today = times.local(now, zone.zone_for(user)).date()
    try:
        def _upcoming(session):
            rows = CalendarEntryRepository(session).upcoming(user.id, now, today, limit)
            return [entries.to_response(r) for r in rows]

        return await get_db_service().execute(_upcoming)
    except Exception as e:
        raise internal_error(e, "Error reading the calendar")


@router.get("/entries/{entry_id}")
async def get_entry(entry_id: int, user: User = Depends(get_authenticated_user)):
    def _get(session):
        row = CalendarEntryRepository(session).get_for_user(user.id, entry_id)
        return entries.to_response(row) if row else None

    result = await get_db_service().execute(_get)
    if result is None:
        raise HTTPException(status_code=404, detail="Not found")
    return result


@router.post("/entries", status_code=201)
async def create_entry(body: EntryCreate, user: User = Depends(get_authenticated_user)):
    try:
        columns = entries.validate(
            kind=body.kind,
            title=body.title,
            notes=body.notes,
            all_day=body.all_day,
            starts_at=_instant(body.starts_at),
            ends_at=_instant(body.ends_at),
            start_date=body.start_date,
            end_date=body.end_date,
        )
    except entries.EntryError as e:
        raise HTTPException(status_code=400, detail=str(e))

    def _create(session):
        now = datetime.utcnow()
        row = CalendarEntryRepository(session).create(
            user_id=user.id, created_at=now, updated_at=now, **columns,
        )
        return entries.to_response(row)

    try:
        return await get_db_service().execute(_create)
    except Exception as e:
        raise internal_error(e, "Error adding to the calendar")


@router.patch("/entries/{entry_id}")
async def update_entry(
    entry_id: int, body: EntryUpdate, user: User = Depends(get_authenticated_user),
):
    changes = {key: getattr(body, key) for key in body.model_fields_set}
    for key in ("starts_at", "ends_at"):
        if key in changes:
            changes[key] = _instant(changes[key])

    def _update(session):
        row = CalendarEntryRepository(session).get_for_user(user.id, entry_id)
        if row is None:
            raise _NotFound()
        entries.apply_update(row, changes)
        session.flush()
        return entries.to_response(row)

    try:
        entry = await get_db_service().execute(_update)
    except _NotFound:
        raise HTTPException(status_code=404, detail="Not found")
    except entries.EntryError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise internal_error(e, "Error changing the calendar")
    if entry["kind"] == "reminder" and (changes.get("done") or "starts_at" in changes):
        await delivery.withdraw(user.id, entry_id)
    return entry


@router.delete("/entries/{entry_id}", status_code=204)
async def delete_entry(entry_id: int, user: User = Depends(get_authenticated_user)):
    def _delete(session):
        repo = CalendarEntryRepository(session)
        row = repo.get_for_user(user.id, entry_id)
        if row is None:
            return False
        repo.delete(row)
        return True

    try:
        deleted = await get_db_service().execute(_delete)
    except Exception as e:
        raise internal_error(e, "Error changing the calendar")
    if not deleted:
        raise HTTPException(status_code=404, detail="Not found")
    await delivery.withdraw(user.id, entry_id)
    return Response(status_code=204)
