"""When a task runs (#352): what the assistant asked for, the next run, and its label.

Pure functions, no database and no clock: every time handed in and every time
handed back is a naive UTC ``datetime``, the convention of every timestamp
column in this schema. A schedule's own times — "07:30 on weekdays" — are wall
times in the schedule's ``timezone``, so a daily run stays at 07:30 across a
clock change rather than drifting by the hour.

The repeats are deliberately few, enough for "every morning", "every Monday"
and "every hour" without a cron dialect the model would have to write:

- ``now``      — once, as soon as it is created (a background task);
- ``once``     — once, at ``at``;
- ``daily``    — every day at ``time``;
- ``weekdays`` — Monday to Friday at ``time``;
- ``weekly``   — on ``days`` at ``time``;
- ``hourly``   — every ``every_hours`` hours, counted from the last run.
"""

from dataclasses import dataclass
from datetime import datetime, time as dt_time, timedelta, timezone as dt_timezone
from typing import Iterable, Optional, Sequence, Tuple, Union
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

REPEATS = ("now", "once", "daily", "weekdays", "weekly", "hourly")
ONE_OFF = frozenset({"now", "once"})

DAY_NAMES = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_DAY_PLURALS = ("Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays")
_FULL_DAY_NAMES = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")


class ScheduleError(ValueError):
    """A schedule that cannot run. The message is shown to the model and the user."""


@dataclass(frozen=True)
class Schedule:
    repeat: str
    timezone: str = "UTC"
    #: ``once``: the local wall time it runs at, or an aware time when the
    #: request carried an offset.
    at: Optional[datetime] = None
    #: ``daily`` / ``weekdays`` / ``weekly``: "HH:MM" in ``timezone``.
    time: Optional[str] = None
    #: ``weekly``: 0 = Monday … 6 = Sunday, sorted, no repeats.
    days: Tuple[int, ...] = ()
    #: ``hourly``: hours between runs.
    every_hours: Optional[int] = None

    @property
    def one_off(self) -> bool:
        return self.repeat in ONE_OFF

    @property
    def day_names(self) -> list:
        return [DAY_NAMES[d] for d in self.days]


def _zone(name: Optional[str]) -> Tuple[str, ZoneInfo]:
    name = (name or "UTC").strip() or "UTC"
    try:
        return name, ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        raise ScheduleError(
            f"Unknown timezone '{name}'. Use an IANA name such as Europe/Paris or America/New_York."
        ) from None


def _parse_time(value: Optional[str]) -> str:
    if value is None or str(value).strip() == "":
        raise ScheduleError("This schedule needs a time of day as HH:MM, for example 07:30.")
    text = str(value).strip()
    try:
        parsed = datetime.strptime(text, "%H:%M")
    except ValueError:
        raise ScheduleError(f"'{text}' is not a time of day as HH:MM (24-hour), for example 07:30.") from None
    return parsed.strftime("%H:%M")


def _parse_day(value: Union[str, int]) -> int:
    if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 6:
        return value
    text = str(value).strip().lower()
    if text in DAY_NAMES:
        return DAY_NAMES.index(text)
    if text in _FULL_DAY_NAMES:
        return _FULL_DAY_NAMES.index(text)
    raise ScheduleError(f"'{value}' is not a day of the week. Use mon, tue, wed, thu, fri, sat or sun.")


def _parse_at(value: Optional[str]) -> datetime:
    if value is None or str(value).strip() == "":
        raise ScheduleError("A one-time task needs 'at': the date and time it runs, as 2026-10-14T08:00.")
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        raise ScheduleError(
            f"'at' must be a date and time as 2026-10-14T08:00, not '{value}'."
        ) from None


def parse_schedule(
    repeat: str,
    *,
    timezone: Optional[str] = None,
    at: Optional[str] = None,
    time: Optional[str] = None,
    days: Optional[Iterable[Union[str, int]]] = None,
    every_hours: Optional[int] = None,
) -> Schedule:
    """Check what was asked for and normalise it. Raises :class:`ScheduleError`."""
    repeat = (repeat or "").strip().lower()
    if repeat not in REPEATS:
        raise ScheduleError(f"'{repeat}' is not a schedule. Use one of: {', '.join(REPEATS)}.")
    tz_name, _ = _zone(timezone)

    if repeat == "now":
        return Schedule(repeat="now", timezone=tz_name)
    if repeat == "once":
        return Schedule(repeat="once", timezone=tz_name, at=_parse_at(at))
    if repeat == "hourly":
        try:
            hours = int(every_hours) if every_hours is not None else None
        except (TypeError, ValueError):
            hours = None
        if hours is None or hours < 1:
            raise ScheduleError("An hourly task needs every_hours: a whole number of hours, 1 or more.")
        return Schedule(repeat="hourly", timezone=tz_name, every_hours=hours)

    hhmm = _parse_time(time)
    if repeat == "weekly":
        parsed = sorted({_parse_day(d) for d in (days or [])})
        if not parsed:
            raise ScheduleError("A weekly task needs days: which days of the week it runs, such as [\"mon\", \"thu\"].")
        return Schedule(repeat="weekly", timezone=tz_name, time=hhmm, days=tuple(parsed))
    return Schedule(repeat=repeat, timezone=tz_name, time=hhmm)


def _to_utc_naive(moment: datetime) -> datetime:
    return moment.astimezone(dt_timezone.utc).replace(tzinfo=None)


def _once_utc(schedule: Schedule) -> datetime:
    at = schedule.at
    if at.tzinfo is not None:
        return _to_utc_naive(at)
    _, zone = _zone(schedule.timezone)
    return _to_utc_naive(at.replace(tzinfo=zone))


def _allowed_days(schedule: Schedule) -> Sequence[int]:
    if schedule.repeat == "weekdays":
        return (0, 1, 2, 3, 4)
    if schedule.repeat == "weekly":
        return schedule.days
    return range(7)


def next_run(schedule: Schedule, after: datetime) -> Optional[datetime]:
    """The first run strictly after ``after``, or None when there is none.

    One-off schedules have no next run: they ran, or they are about to.
    """
    if schedule.one_off:
        return None
    if schedule.repeat == "hourly":
        return after + timedelta(hours=schedule.every_hours)

    _, zone = _zone(schedule.timezone)
    hours, minutes = (int(part) for part in schedule.time.split(":"))
    local_after = after.replace(tzinfo=dt_timezone.utc).astimezone(zone)
    allowed = set(_allowed_days(schedule))
    # Eight days covers every weekly pattern, including "today, but earlier".
    for offset in range(0, 8):
        day = (local_after + timedelta(days=offset)).date()
        if day.weekday() not in allowed:
            continue
        candidate = datetime.combine(day, dt_time(hours, minutes), tzinfo=zone)
        candidate_utc = _to_utc_naive(candidate)
        if candidate_utc > after:
            return candidate_utc
    return None  # pragma: no cover - unreachable with at least one allowed day


def first_run(schedule: Schedule, now: datetime) -> datetime:
    """When a newly created task first runs."""
    if schedule.repeat == "now":
        return now
    if schedule.repeat == "once":
        moment = _once_utc(schedule)
        if moment <= now:
            raise ScheduleError("That time has already passed. Pick a time in the future.")
        return moment
    return next_run(schedule, now)


def _join(words: Sequence[str]) -> str:
    if len(words) <= 1:
        return "".join(words)
    return ", ".join(words[:-1]) + " and " + words[-1]


def describe(schedule: Schedule) -> str:
    """The schedule in a few words, as the Tasks screen and the chat show it."""
    if schedule.repeat == "now":
        return "Right away"
    if schedule.repeat == "hourly":
        label = "Every hour" if schedule.every_hours == 1 else f"Every {schedule.every_hours} hours"
        return label
    if schedule.repeat == "once":
        at = schedule.at
        if at.tzinfo is not None:
            _, zone = _zone(schedule.timezone)
            at = at.astimezone(zone)
        label = f"Once · {at.strftime('%A')} {at.day} {at.strftime('%B %Y, %H:%M')}"
    elif schedule.repeat == "daily":
        label = f"Every day at {schedule.time}"
    elif schedule.repeat == "weekdays":
        label = f"Weekdays at {schedule.time}"
    else:
        label = f"{_join([_DAY_PLURALS[d] for d in schedule.days])} at {schedule.time}"
    if schedule.timezone != "UTC":
        label += f" ({schedule.timezone})"
    return label
