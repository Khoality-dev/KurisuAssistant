"""The assistant's calendar tools (#282): create, list, move and delete.

"Remind me to call Mom on Friday" should put a reminder on the user's calendar.
These tools are how: they go through ``CalendarEntryRepository`` and
``calendar/entries.validate`` — the same layer the REST router uses — so the
assistant can put nothing on a calendar that the Calendar screen could not.

Time is the user's. The model writes wall-clock time ("2026-10-16T19:00") and
the tools read it in the account's zone (``calendar/zone.zone_for``, UTC until
#352 brings the account setting);
what they answer is in that zone too, with the zone named. Create and move
answer in JSON carrying the entry, which is what both clients draw the chat's
calendar card from; the ``summary`` is the sentence for the model.

The calendar never starts the assistant. Nothing here schedules work — that is a
task (#352). A reminder only notifies the user when it is due.

Built in, like the history and recall tools: the calendar is one of the
assistant's own features (#268), not an add-on an allowlist should have to
name. Approval still applies — ``users.tool_policies`` is checked in
``agents/base.py`` before any of this runs.
"""

import json
import logging
from datetime import date, datetime, timedelta
from typing import Any, Dict, Optional, Tuple

from .base import BaseTool

logger = logging.getLogger(__name__)

#: A listing with no window covers this far ahead from now.
DEFAULT_LIST_DAYS = 14
#: …and never more than this many entries, so one call cannot fill the context.
MAX_LIST_ENTRIES = 100


def _error(sentence: str) -> str:
    return json.dumps({"error": sentence})


def _text(value: Any) -> str:
    if value is None:
        return ""
    return value if isinstance(value, str) else str(value)


def _entry_id(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


async def _zone(user_id: int):
    """The account's zone, through the calendar's one lookup (``calendar/zone.py``)."""
    from kurisuassistant.calendar import zone
    from kurisuassistant.db.models import User
    from kurisuassistant.db.service import get_db_service

    def _read(session):
        return zone.zone_for(session.get(User, user_id))

    return await get_db_service().execute(_read)


def describe_entry(row, tz) -> str:
    """``the reminder “Call Mom” on Fri 16 Oct 2026, 19:00`` and the like."""
    from kurisuassistant.calendar import times

    if row.all_day:
        when = times.format_date(row.start_date)
        if row.end_date and row.end_date != row.start_date:
            when += f" to {times.format_date(row.end_date)}"
        when += " (all day)"
    elif row.kind == "reminder":
        when = times.format_local(row.starts_at, tz)
    else:
        when = times.format_local(row.starts_at, tz)
        if row.ends_at:
            if times.local(row.ends_at, tz).date() == times.local(row.starts_at, tz).date():
                when += f" to {times.format_time(row.ends_at, tz)}"
            else:
                when += f" to {times.format_local(row.ends_at, tz)}"
    return f"the {row.kind} “{row.title}” on {when}"


def _card(row, tz, summary: str) -> str:
    from kurisuassistant.calendar import entries

    return json.dumps({
        "summary": summary,
        "entry": entries.to_response(row),
        "time_zone": tz.key,
    })


def _split(value: Any, tz) -> Tuple[Optional[datetime], Optional[date]]:
    """What the model wrote, as ``(instant, None)`` or ``(None, date)``."""
    from kurisuassistant.calendar import times

    parsed = times.parse_local(value, tz)
    if isinstance(parsed, datetime):
        return parsed, None
    return None, parsed


class CalendarCreateTool(BaseTool):
    name = "calendar_create"
    built_in = True
    description = (
        "Put an event or a reminder on the user's calendar. A reminder notifies the "
        "user at its time; an event is something happening, timed or all day. Times "
        "are the user's local wall-clock time, e.g. '2026-10-16T19:00'; give a date "
        "alone, e.g. '2026-10-18', for an all-day event. Nothing on the calendar "
        "makes you do anything later."
    )

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "kind": {"type": "string", "enum": ["event", "reminder"]},
                        "title": {"type": "string", "description": "What it is, e.g. 'Call Mom'."},
                        "start": {
                            "type": "string",
                            "description": "Local date and time ('2026-10-16T19:00'), or a date for an all-day event.",
                        },
                        "end": {
                            "type": "string",
                            "description": "Events only: when it ends. Defaults to an hour after a timed start, or the same day.",
                        },
                        "notes": {"type": "string", "description": "Anything else worth keeping with it."},
                    },
                    "required": ["kind", "title", "start"],
                },
            },
        }

    def describe_call(self, args: Dict[str, Any]) -> str:
        kind = _text(args.get("kind")) or "entry"
        title = _text(args.get("title")) or "untitled"
        start = _text(args.get("start")).replace("T", " ")
        return f"Add the {kind} “{title}” to the calendar at {start}"

    async def execute(self, args: Dict[str, Any]) -> str:
        from kurisuassistant.calendar import entries, times
        from kurisuassistant.db.repositories import CalendarEntryRepository
        from kurisuassistant.db.service import get_db_service

        user_id = args.get("user_id")
        if not user_id:
            return _error("No user context available.")
        tz = await _zone(user_id)

        try:
            starts_at, start_date = _split(args.get("start"), tz)
            ends_at = end_date = None
            if args.get("end"):
                ends_at, end_date = _split(args.get("end"), tz)
            kind = _text(args.get("kind"))
            if kind == "reminder" and starts_at is None:
                raise entries.EntryError("A reminder needs a date and a time, e.g. 2026-10-16T19:00.")
            if args.get("end") and (starts_at is None) != (ends_at is None):
                raise entries.EntryError(
                    "Give the start and the end the same way: both dates, or both dates with times."
                )
            columns = entries.validate(
                kind=kind,
                title=args.get("title"),
                notes=args.get("notes"),
                all_day=start_date is not None,
                starts_at=starts_at,
                ends_at=ends_at,
                start_date=start_date,
                end_date=end_date,
            )
        except ValueError as e:
            return _error(str(e))

        def _create(session):
            now = datetime.utcnow()
            row = CalendarEntryRepository(session).create(
                user_id=user_id, created_at=now, updated_at=now, **columns,
            )
            return _card(row, tz, f"Added {describe_entry(row, tz)} ({tz.key}).")

        return await get_db_service().execute(_create)


class CalendarListTool(BaseTool):
    name = "calendar_list"
    built_in = True
    description = (
        "List what is on the user's calendar — events and reminders, each with its id — "
        "between two local dates or times. Defaults to the next two weeks."
    )

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "from": {"type": "string", "description": "Local date or date and time. Defaults to now."},
                        "to": {"type": "string", "description": "Local date (included) or date and time."},
                    },
                    "required": [],
                },
            },
        }

    def describe_call(self, args: Dict[str, Any]) -> str:
        return "Look at the calendar"

    async def execute(self, args: Dict[str, Any]) -> str:
        from kurisuassistant.calendar import times
        from kurisuassistant.db.repositories import CalendarEntryRepository
        from kurisuassistant.db.service import get_db_service

        user_id = args.get("user_id")
        if not user_id:
            return _error("No user context available.")
        tz = await _zone(user_id)

        def _bound(value, *, end: bool) -> datetime:
            parsed = times.parse_local(value, tz)
            if isinstance(parsed, datetime):
                return parsed
            # A date: its local midnight, or the next one when it ends the window.
            day = parsed + timedelta(days=1) if end else parsed
            return times.parse_local(f"{day.isoformat()}T00:00", tz)

        try:
            start = _bound(args["from"], end=False) if args.get("from") else datetime.utcnow()
            end = (
                _bound(args["to"], end=True)
                if args.get("to")
                else start + timedelta(days=DEFAULT_LIST_DAYS)
            )
        except ValueError as e:
            return _error(str(e))
        if end <= start:
            return _error("The end of the window has to come after its start.")
        if end - start > timedelta(days=366):
            return _error("Ask for at most a year at a time.")

        def _list(session):
            rows = CalendarEntryRepository(session).in_window(user_id, start, end)
            lines = []
            for row in rows[:MAX_LIST_ENTRIES]:
                if row.all_day and (
                    row.end_date < times.local(start, tz).date()
                    or row.start_date > times.local(end - timedelta(seconds=1), tz).date()
                ):
                    continue  # matched a day wide on purpose; not in this window after all
                done = " (done)" if row.done_at else ""
                lines.append(f"- #{row.id}: {describe_entry(row, tz)}{done}")
            return lines, len(rows) > MAX_LIST_ENTRIES

        lines, truncated = await get_db_service().execute(_list)
        window = (
            f"{times.format_local(start, tz)} to {times.format_local(end, tz)} ({tz.key})"
        )
        if not lines:
            return f"Nothing on the calendar from {window}."
        head = f"On the calendar from {window}:"
        tail = ["…and more, not listed. Ask for a shorter window."] if truncated else []
        return "\n".join([head, *lines, *tail])


class CalendarMoveTool(BaseTool):
    name = "calendar_move"
    built_in = True
    description = (
        "Move an event or reminder on the user's calendar to a new local time (or a new "
        "date, for an all-day event). An event keeps its length unless an end is given. "
        "Find the id with calendar_list."
    )

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "integer", "description": "The entry's id from calendar_list."},
                        "start": {"type": "string", "description": "New local start ('2026-10-17T10:00'), or a date."},
                        "end": {"type": "string", "description": "Events only: a new end."},
                    },
                    "required": ["id", "start"],
                },
            },
        }

    def describe_call(self, args: Dict[str, Any]) -> str:
        return f"Move calendar entry #{_text(args.get('id'))} to {_text(args.get('start')).replace('T', ' ')}"

    async def execute(self, args: Dict[str, Any]) -> str:
        from kurisuassistant.calendar import entries, times
        from kurisuassistant.db.repositories import CalendarEntryRepository
        from kurisuassistant.db.service import get_db_service

        user_id = args.get("user_id")
        if not user_id:
            return _error("No user context available.")
        entry_id = _entry_id(args.get("id"))
        if entry_id is None:
            return _error("Name the entry by its id from calendar_list.")
        tz = await _zone(user_id)
        try:
            starts_at, start_date = _split(args.get("start"), tz)
            ends_at = end_date = None
            if args.get("end"):
                ends_at, end_date = _split(args.get("end"), tz)
        except ValueError as e:
            return _error(str(e))

        def _move(session):
            row = CalendarEntryRepository(session).get_for_user(user_id, entry_id)
            if row is None:
                return _error(f"There is no calendar entry #{entry_id}.")
            if row.all_day and start_date is None:
                return _error("That event lasts all day; move it to a date, e.g. 2026-10-19.")
            if not row.all_day and starts_at is None:
                return _error("Give a date and a time, e.g. 2026-10-17T10:00.")
            changes: Dict[str, Any] = {}
            if row.all_day:
                changes["start_date"] = start_date
                if end_date is not None:
                    changes["end_date"] = end_date
            else:
                changes["starts_at"] = starts_at
                if ends_at is not None:
                    changes["ends_at"] = ends_at
            try:
                entries.apply_update(row, changes)
            except entries.EntryError as e:
                return _error(str(e))
            session.flush()
            return _card(row, tz, f"Moved {describe_entry(row, tz)} ({tz.key}).")

        return await get_db_service().execute(_move)


class CalendarDeleteTool(BaseTool):
    name = "calendar_delete"
    built_in = True
    description = "Delete an event or reminder from the user's calendar by its id from calendar_list."

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "integer", "description": "The entry's id from calendar_list."},
                    },
                    "required": ["id"],
                },
            },
        }

    def describe_call(self, args: Dict[str, Any]) -> str:
        return f"Delete calendar entry #{_text(args.get('id'))}"

    async def execute(self, args: Dict[str, Any]) -> str:
        from kurisuassistant.calendar import times
        from kurisuassistant.db.repositories import CalendarEntryRepository
        from kurisuassistant.db.service import get_db_service

        user_id = args.get("user_id")
        if not user_id:
            return _error("No user context available.")
        entry_id = _entry_id(args.get("id"))
        if entry_id is None:
            return _error("Name the entry by its id from calendar_list.")
        tz = await _zone(user_id)

        def _delete(session):
            repo = CalendarEntryRepository(session)
            row = repo.get_for_user(user_id, entry_id)
            if row is None:
                return _error(f"There is no calendar entry #{entry_id}.")
            sentence = f"Deleted {describe_entry(row, tz)}."
            gone = {"id": row.id, "kind": row.kind, "title": row.title}
            repo.delete(row)
            return json.dumps({"summary": sentence, "deleted": gone})

        return await get_db_service().execute(_delete)
