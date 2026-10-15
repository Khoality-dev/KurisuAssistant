"""What can be on a calendar, decided once.

The REST router and the assistant's tools both create and move entries, and
both go through :func:`validate` — so a reminder without a time, an event that
ends before it starts, or a title of a thousand characters is refused the same
way whoever asked. Refusals are :class:`EntryError`, whose message is a sentence
a person (or a model) can act on.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any, Dict, Optional

KINDS = ("event", "reminder")
MAX_TITLE_LENGTH = 200
MAX_NOTES_LENGTH = 4000
#: A timed event given no end lasts this long — what both clients' "New" offers.
DEFAULT_EVENT_LENGTH = timedelta(hours=1)
#: The longest window one listing may cover. A week view asks for seven days;
#: this only stops a request for every entry an account ever made.
MAX_WINDOW = timedelta(days=366)


class EntryError(ValueError):
    """An entry that cannot be on a calendar. ``str()`` is the sentence."""


def validate(
    *,
    kind: Any,
    title: Any,
    notes: Any = None,
    all_day: bool = False,
    starts_at: Optional[datetime] = None,
    ends_at: Optional[datetime] = None,
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
) -> Dict[str, Any]:
    """The columns of a valid entry, or :class:`EntryError`.

    Fills what has a sensible default — an hour for a timed event with no end,
    the same day for an all-day event with no end date — and clears the columns
    the entry's shape does not use, so a timed event never carries a stale date.
    """
    if kind not in KINDS:
        raise EntryError("An entry is either an event or a reminder.")
    if not isinstance(title, str) or not title.strip():
        raise EntryError("An entry needs a title.")
    title = title.strip()
    if len(title) > MAX_TITLE_LENGTH:
        raise EntryError(f"A title is at most {MAX_TITLE_LENGTH} characters.")
    if notes is not None:
        if not isinstance(notes, str):
            notes = str(notes)
        notes = notes.strip() or None
        if notes and len(notes) > MAX_NOTES_LENGTH:
            raise EntryError(f"Notes are at most {MAX_NOTES_LENGTH} characters.")

    if kind == "reminder":
        if all_day or starts_at is None:
            raise EntryError("A reminder needs a date and a time.")
        return {
            "kind": kind, "title": title, "notes": notes, "all_day": False,
            "starts_at": starts_at, "ends_at": None, "start_date": None, "end_date": None,
        }

    if all_day:
        if start_date is None:
            raise EntryError("An all-day event needs a date.")
        end_date = end_date or start_date
        if end_date < start_date:
            raise EntryError("An event cannot end before it starts.")
        return {
            "kind": kind, "title": title, "notes": notes, "all_day": True,
            "starts_at": None, "ends_at": None, "start_date": start_date, "end_date": end_date,
        }

    if starts_at is None:
        raise EntryError("An event needs a start time, or a date if it lasts all day.")
    ends_at = ends_at or starts_at + DEFAULT_EVENT_LENGTH
    if ends_at <= starts_at:
        raise EntryError("An event cannot end before it starts.")
    return {
        "kind": kind, "title": title, "notes": notes, "all_day": False,
        "starts_at": starts_at, "ends_at": ends_at, "start_date": None, "end_date": None,
    }


def columns_of(row) -> Dict[str, Any]:
    """A stored entry's shape, as :func:`validate` takes it."""
    return {
        "kind": row.kind, "title": row.title, "notes": row.notes, "all_day": row.all_day,
        "starts_at": row.starts_at, "ends_at": row.ends_at,
        "start_date": row.start_date, "end_date": row.end_date,
    }


def to_response(row) -> Dict[str, Any]:
    """An entry as both clients read it. Nothing says who put it there."""
    from kurisuassistant.calendar.times import to_wire

    return {
        "id": row.id,
        "kind": row.kind,
        "title": row.title,
        "notes": row.notes,
        "all_day": bool(row.all_day),
        "starts_at": to_wire(row.starts_at),
        "ends_at": to_wire(row.ends_at),
        "start_date": row.start_date.isoformat() if row.start_date else None,
        "end_date": row.end_date.isoformat() if row.end_date else None,
        "done": row.done_at is not None,
        "done_at": to_wire(row.done_at),
        "created_at": to_wire(row.created_at),
        "updated_at": to_wire(row.updated_at),
    }


def apply_update(row, changes: dict) -> None:
    """Move, rename or mark ``row`` done, validated as a whole before anything is
    written. Raises :class:`EntryError` and leaves the row untouched.

    Moving a timed event's start without naming an end keeps its length — that
    is what "move" means on a calendar. Moving a reminder makes it due again.
    """
    merged = columns_of(row)
    for key in ("title", "notes", "all_day", "start_date", "end_date"):
        if key in changes:
            merged[key] = changes[key]
    if (
        "start_date" in changes
        and "end_date" not in changes
        and row.start_date is not None
        and row.end_date is not None
        and changes["start_date"] is not None
    ):
        merged["end_date"] = changes["start_date"] + (row.end_date - row.start_date)
    if "starts_at" in changes:
        new_start = changes["starts_at"]
        if (
            "ends_at" not in changes
            and row.kind == "event"
            and row.starts_at is not None
            and row.ends_at is not None
            and new_start is not None
        ):
            merged["ends_at"] = new_start + (row.ends_at - row.starts_at)
        merged["starts_at"] = new_start
    if "ends_at" in changes:
        merged["ends_at"] = changes["ends_at"]
    if merged.get("all_day") is None:
        merged["all_day"] = False

    columns = validate(**merged)

    if "done" in changes and row.kind != "reminder":
        raise EntryError("Only a reminder can be marked done.")

    moved = row.kind == "reminder" and columns["starts_at"] != row.starts_at
    for key, value in columns.items():
        setattr(row, key, value)
    if moved:
        row.delivered_at = None
        row.delivery_attempts = 0
    if "done" in changes:
        if changes["done"]:
            row.done_at = row.done_at or datetime.utcnow()
        else:
            row.done_at = None
    row.updated_at = datetime.utcnow()
