"""How a reminder repeats (#355), decided once.

A reminder can come back every day, every weekday (Monday to Friday), or every
week on chosen days. Its times are wall-clock time in the account's zone: the
series' first time, ``starts_at``, gives the first day and the time of day, and
every later time is that time of day on a later matching day — so 08:00 stays
08:00 when the clocks change, which a fixed 24-hour step would not.

A series is anything with ``starts_at`` (naive UTC), ``repeat`` and
``repeat_days`` (the stored ``"mon,thu"``), so the REST routes, the tools, the
scanner and the tests all ask the same functions. Instants in and out are naive
UTC, like every other column.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Iterable, List, Optional, Tuple
from zoneinfo import ZoneInfo

RULES = ("daily", "weekdays", "weekly")
DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_DAY_NAMES = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
#: What a client or a model may send for "does not repeat".
NO_REPEAT = (None, "", "none")
#: Every rule has a time in any run of this many days, so a search this wide
#: finds the neighbour of any moment.
_SEARCH_DAYS = 9


def normalize(rule, days: Optional[Iterable[str]]) -> Tuple[Optional[str], Optional[str]]:
    """``(rule, stored days)`` for what was asked, or :class:`EntryError`.

    Days are only for a weekly repeat, which needs at least one; they are
    stored lower-case, once each, Monday first.
    """
    from kurisuassistant.calendar.entries import EntryError

    if rule in NO_REPEAT:
        if days:
            raise EntryError("Days only go with a weekly repeat.")
        return None, None
    if rule not in RULES:
        raise EntryError("A reminder repeats every day, every weekday, or every week on chosen days.")
    wanted = [str(d).strip().lower() for d in (days or [])]
    if rule != "weekly":
        if wanted:
            raise EntryError("Days only go with a weekly repeat.")
        return rule, None
    unknown = [d for d in wanted if d not in DAYS]
    if unknown:
        raise EntryError(f"{unknown[0]!r} is not a day. Use mon, tue, wed, thu, fri, sat or sun.")
    if not wanted:
        raise EntryError("A weekly repeat needs at least one day.")
    return rule, ",".join(d for d in DAYS if d in wanted)


def days_of(stored: Optional[str]) -> List[str]:
    """The stored ``"mon,thu"`` as ``["mon", "thu"]``."""
    return [d for d in (stored or "").split(",") if d]


def _local(value: datetime, tz: ZoneInfo) -> datetime:
    return value.replace(tzinfo=timezone.utc).astimezone(tz)


def _instant(day: date, clock: time, tz: ZoneInfo) -> datetime:
    return datetime.combine(day, clock, tzinfo=tz).astimezone(timezone.utc).replace(tzinfo=None)


def _matches(series, day: date) -> bool:
    if series.repeat == "daily":
        return True
    if series.repeat == "weekdays":
        return day.weekday() < 5
    if series.repeat == "weekly":
        return DAYS[day.weekday()] in days_of(series.repeat_days)
    return False


def _times_on(series, tz: ZoneInfo, days: Iterable[date]) -> Iterable[datetime]:
    """The series' times on ``days``, in that order, none before its first."""
    first = _local(series.starts_at, tz)
    for day in days:
        if day < first.date() or not _matches(series, day):
            continue
        at = _instant(day, first.time(), tz)
        if at >= series.starts_at:
            yield at


def _repeats(series) -> bool:
    return bool(getattr(series, "repeat", None)) and series.starts_at is not None


def occurrences(series, tz: ZoneInfo, start: datetime, end: datetime) -> List[datetime]:
    """Every time of ``series`` in ``[start, end)``, in order."""
    if not _repeats(series) or end <= start:
        return []
    lo = _local(start, tz).date() - timedelta(days=1)
    hi = _local(end, tz).date() + timedelta(days=1)
    days = (lo + timedelta(days=n) for n in range((hi - lo).days + 1))
    return [at for at in _times_on(series, tz, days) if start <= at < end]


def next_at_or_after(series, tz: ZoneInfo, at: datetime) -> Optional[datetime]:
    """The first time of ``series`` at ``at`` or later."""
    if not _repeats(series):
        return None
    lo = max(_local(at, tz).date(), _local(series.starts_at, tz).date()) - timedelta(days=1)
    days = (lo + timedelta(days=n) for n in range(_SEARCH_DAYS))
    return next((t for t in _times_on(series, tz, days) if t >= at), None)


def next_after(series, tz: ZoneInfo, at: datetime) -> Optional[datetime]:
    """The first time of ``series`` strictly after ``at``."""
    found = next_at_or_after(series, tz, at)
    if found is not None and found == at:
        found = next_at_or_after(series, tz, at + timedelta(seconds=1))
    return found


def latest_at_or_before(series, tz: ZoneInfo, at: datetime) -> Optional[datetime]:
    """The last time of ``series`` that came at ``at`` or before — None before its first."""
    if not _repeats(series) or at < series.starts_at:
        return None
    hi = _local(at, tz).date() + timedelta(days=1)
    days = [hi - timedelta(days=n) for n in range(_SEARCH_DAYS)]
    return next((t for t in _times_on(series, tz, days) if t <= at), None)


def is_occurrence(series, tz: ZoneInfo, at: datetime) -> bool:
    """Whether ``at`` is one of the series' times."""
    return next_at_or_after(series, tz, at) == at


def describe(series, tz: ZoneInfo) -> str:
    """``every day at 08:00``, ``every Monday and Thursday at 19:00``."""
    clock = f"{_local(series.starts_at, tz):%H:%M}"
    if series.repeat == "daily":
        return f"every day at {clock}"
    if series.repeat == "weekdays":
        return f"every weekday at {clock}"
    names = [_DAY_NAMES[DAYS.index(d)] for d in days_of(series.repeat_days)]
    listed = names[0] if len(names) == 1 else f"{', '.join(names[:-1])} and {names[-1]}"
    return f"every {listed} at {clock}"
