"""What can be on a calendar, decided once.

The REST router and the assistant's tools both create and move entries, and
both go through :func:`validate` — so a reminder without a time, an event that
ends before it starts, or a title of a thousand characters is refused the same
way whoever asked. Refusals are :class:`EntryError`, whose message is a sentence
a person (or a model) can act on.

A reminder can repeat (#355). The row is the series — its rule, and its first
time in ``starts_at`` — and what a client or the model sees is one of its times:
:func:`to_response` with ``at``, and :func:`expand` for a window. Done is per
time (``CalendarOccurrence``); the row's own ``done_at`` stays empty.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional

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
    repeat: Any = None,
    repeat_days: Any = None,
) -> Dict[str, Any]:
    """The columns of a valid entry, or :class:`EntryError`.

    Fills what has a sensible default — an hour for a timed event with no end,
    the same day for an all-day event with no end date — and clears the columns
    the entry's shape does not use, so a timed event never carries a stale date.
    Only a reminder repeats.
    """
    from kurisuassistant.calendar import repeat as repeats

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

    if kind != "reminder" and (repeat not in repeats.NO_REPEAT or repeat_days):
        raise EntryError("Only a reminder can repeat.")
    rule, days = repeats.normalize(repeat, repeat_days)
    no_repeat = {"repeat": None, "repeat_days": None}

    if kind == "reminder":
        if all_day or starts_at is None:
            raise EntryError("A reminder needs a date and a time.")
        return {
            "kind": kind, "title": title, "notes": notes, "all_day": False,
            "starts_at": starts_at, "ends_at": None, "start_date": None, "end_date": None,
            "repeat": rule, "repeat_days": days,
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
            **no_repeat,
        }

    if starts_at is None:
        raise EntryError("An event needs a start time, or a date if it lasts all day.")
    ends_at = ends_at or starts_at + DEFAULT_EVENT_LENGTH
    if ends_at <= starts_at:
        raise EntryError("An event cannot end before it starts.")
    return {
        "kind": kind, "title": title, "notes": notes, "all_day": False,
        "starts_at": starts_at, "ends_at": ends_at, "start_date": None, "end_date": None,
        **no_repeat,
    }


def columns_of(row) -> Dict[str, Any]:
    """A stored entry's shape, as :func:`validate` takes it."""
    from kurisuassistant.calendar import repeat as repeats

    return {
        "kind": row.kind, "title": row.title, "notes": row.notes, "all_day": row.all_day,
        "starts_at": row.starts_at, "ends_at": row.ends_at,
        "start_date": row.start_date, "end_date": row.end_date,
        "repeat": row.repeat, "repeat_days": repeats.days_of(row.repeat_days),
    }


def schedule(row, tz, now: Optional[datetime] = None) -> None:
    """Point a repeating reminder's ``next_due_at`` at its next time from ``now``.

    A time that has already passed is not delivered late: a series created at
    10:00 to start "today at 08:00" first notifies tomorrow.
    """
    from kurisuassistant.calendar import repeat as repeats

    if row.repeat:
        row.next_due_at = repeats.next_at_or_after(row, tz, now or datetime.utcnow())
    else:
        row.next_due_at = None


def _done_times(row) -> Dict[datetime, datetime]:
    return {o.occurs_at: o.done_at for o in (row.occurrences or [])} if row.repeat else {}


def current_time(row, tz, now: Optional[datetime] = None) -> datetime:
    """The time of a repeating reminder that opening it shows: its first from
    the start of the user's today — so this morning's, until tomorrow."""
    from kurisuassistant.calendar import repeat as repeats

    now = now or datetime.utcnow()
    today = now.replace(tzinfo=timezone.utc).astimezone(tz).date()
    midnight = datetime.combine(today, time(0), tzinfo=tz).astimezone(timezone.utc).replace(tzinfo=None)
    return repeats.next_at_or_after(row, tz, midnight) or row.starts_at


def to_response(row, tz, at: Optional[datetime] = None) -> Dict[str, Any]:
    """An entry as both clients read it. Nothing says who put it there.

    A repeating reminder answers as one of its times — ``at``, or
    :func:`current_time` — with that time's done state; ``repeat_from`` is the
    series' first time, which is what an edit changes.
    """
    from kurisuassistant.calendar import repeat as repeats
    from kurisuassistant.calendar.times import to_wire

    starts_at, done_at = row.starts_at, row.done_at
    if row.repeat:
        starts_at = at or current_time(row, tz)
        done_at = _done_times(row).get(starts_at)
    return {
        "id": row.id,
        "kind": row.kind,
        "title": row.title,
        "notes": row.notes,
        "all_day": bool(row.all_day),
        "starts_at": to_wire(starts_at),
        "ends_at": to_wire(row.ends_at),
        "start_date": row.start_date.isoformat() if row.start_date else None,
        "end_date": row.end_date.isoformat() if row.end_date else None,
        "done": done_at is not None,
        "done_at": to_wire(done_at),
        "repeat": row.repeat,
        "repeat_days": repeats.days_of(row.repeat_days),
        "repeat_from": to_wire(row.starts_at) if row.repeat else None,
        "created_at": to_wire(row.created_at),
        "updated_at": to_wire(row.updated_at),
    }


def _order(item: Dict[str, Any]):
    return (item["starts_at"] or f"{item['start_date']}T00:00:00Z", item["id"])


def expand(rows: Iterable, tz, start: datetime, end: datetime) -> List[Dict[str, Any]]:
    """What a window shows: each entry once, and a repeating reminder once for
    each of its times in ``[start, end)`` — in order of when each begins."""
    from kurisuassistant.calendar import repeat as repeats

    items: List[Dict[str, Any]] = []
    for row in rows:
        if row.repeat:
            items.extend(to_response(row, tz, at=t) for t in repeats.occurrences(row, tz, start, end))
        else:
            items.append(to_response(row, tz))
    return sorted(items, key=_order)


def coming_up(one_offs: Iterable, series: Iterable, tz, now: datetime, limit: int) -> List[Dict[str, Any]]:
    """"Coming up": what is still ahead, soonest first — a repeating reminder's
    next times among the rest, its done ones left out like a done reminder."""
    from kurisuassistant.calendar import repeat as repeats

    items = [to_response(row, tz) for row in one_offs]
    for row in series:
        done = _done_times(row)
        at, found = repeats.next_at_or_after(row, tz, now), 0
        for _ in range(limit * 4 + 8):  # bounded, even if a long run is done
            if at is None or found >= limit:
                break
            if at not in done:
                items.append(to_response(row, tz, at=at))
                found += 1
            at = repeats.next_after(row, tz, at)
    return sorted(items, key=_order)[:limit]


#: What changes a repeating reminder's times, as opposed to its title.
_TIMING = ("starts_at", "repeat", "repeat_days")


def apply_update(row, changes: dict, tz, now: Optional[datetime] = None) -> None:
    """Move, rename, repeat or mark ``row`` done, validated as a whole before
    anything is written. Raises :class:`EntryError` and leaves the row untouched.

    Moving a timed event's start without naming an end keeps its length — that
    is what "move" means on a calendar. Moving a reminder makes it due again.

    A repeating reminder (#355): ``starts_at`` moves its first time, and with it
    the time of day of every time; done needs ``occurrence_at``, the time it is
    about. Stopping the repeat (``repeat: None``) leaves a one-off reminder — at
    ``starts_at`` when given, else at its latest time that has come (which does
    not notify again), else at its first.
    """
    from kurisuassistant.calendar import repeat as repeats

    now = now or datetime.utcnow()
    was_repeating = bool(row.repeat)
    merged = columns_of(row)
    for key in ("title", "notes", "all_day", "start_date", "end_date", "repeat", "repeat_days"):
        if key in changes:
            merged[key] = changes[key]
    if "repeat" in changes and "repeat_days" not in changes and changes["repeat"] != "weekly":
        merged["repeat_days"] = None
    stopping = was_repeating and merged["repeat"] in repeats.NO_REPEAT
    stopped_at = None
    if stopping and "starts_at" not in changes:
        stopped_at = (
            repeats.latest_at_or_before(row, tz, now)
            or repeats.next_at_or_after(row, tz, row.starts_at)
            or row.starts_at
        )
        merged["starts_at"] = stopped_at
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
    repeating = bool(columns["repeat"])
    occurrence = changes.get("occurrence_at")
    if "done" in changes and repeating:
        if occurrence is None:
            raise EntryError("Say which time of a repeating reminder is done.")
        probe = _Series(columns["starts_at"], columns["repeat"], columns["repeat_days"])
        if not repeats.is_occurrence(probe, tz, occurrence):
            raise EntryError("That is not one of this reminder's times.")

    retimed = any(
        getattr(row, key) != columns[key] for key in _TIMING
    ) or (repeating and not was_repeating)
    old_start, old_done = row.starts_at, row.done_at
    kept_done = _done_times(row).get(stopped_at) if stopped_at else None

    for key, value in columns.items():
        setattr(row, key, value)

    if repeating:
        if not was_repeating:
            # It was a one-off: its done, if any, belongs to that one time.
            if old_done and repeats.is_occurrence(row, tz, old_start):
                row.occurrences.append(_occurrence(old_start, old_done))
        elif retimed:
            # Times still ahead under the old rule are not this rule's times.
            row.occurrences[:] = [o for o in row.occurrences if o.occurs_at <= now]
        row.done_at = None
        row.delivered_at = None
        if retimed:
            row.delivery_attempts = 0
            schedule(row, tz, now)
    else:
        moved = row.kind == "reminder" and columns["starts_at"] != old_start
        if stopping:
            row.occurrences[:] = []
            row.next_due_at = None
            row.done_at = kept_done
            row.delivery_attempts = 0
            # A time that has come was notified as part of the series.
            row.delivered_at = now if columns["starts_at"] <= now else None
        elif moved:
            row.delivered_at = None
            row.delivery_attempts = 0

    if "done" in changes:
        if repeating:
            _set_done(row, occurrence, bool(changes["done"]))
        elif changes["done"]:
            row.done_at = row.done_at or datetime.utcnow()
        else:
            row.done_at = None
    row.updated_at = datetime.utcnow()


class _Series:
    """A series as it would be after a change, for checking a time against it."""

    def __init__(self, starts_at, repeat, repeat_days):
        self.starts_at, self.repeat, self.repeat_days = starts_at, repeat, repeat_days


def _occurrence(at: datetime, done_at: datetime):
    from kurisuassistant.db.models import CalendarOccurrence

    return CalendarOccurrence(occurs_at=at, done_at=done_at)


def _set_done(row, at: datetime, done: bool) -> None:
    existing = [o for o in row.occurrences if o.occurs_at == at]
    if done and not existing:
        row.occurrences.append(_occurrence(at, datetime.utcnow()))
    elif not done:
        for o in existing:
            row.occurrences.remove(o)
