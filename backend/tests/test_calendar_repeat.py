"""How a repeating reminder repeats (#355): the rules, as wall-clock time.

A reminder can come back every day, every weekday, or every week on chosen
days, always at the same time on the user's clock — so 08:00 stays 08:00 when
the clocks change. ``calendar/repeat.py`` is the one place that turns a rule
into instants; the REST routes, the tools and the scanner all ask it.

No database: a series is anything with ``starts_at``, ``repeat`` and
``repeat_days``.
"""

from datetime import datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

from kurisuassistant.calendar import repeat
from kurisuassistant.calendar.entries import EntryError

LA = ZoneInfo("America/Los_Angeles")


def series(rule, days=None, *, first=datetime(2026, 10, 16, 15, 0)):
    """Fri 16 Oct 2026, 08:00 in Los Angeles (15:00 UTC), repeating by ``rule``."""
    return SimpleNamespace(starts_at=first, repeat=rule, repeat_days=",".join(days) if days else None)


def local_times(instants):
    return [i.replace(tzinfo=ZoneInfo("UTC")).astimezone(LA).strftime("%a %d %H:%M") for i in instants]


class TestOccurrences:
    def test_every_day_keeps_the_wall_clock_time_across_the_clock_change(self):
        # Clocks go back in Los Angeles on Sun 1 Nov 2026.
        times = repeat.occurrences(
            series("daily"), LA, datetime(2026, 10, 30, 0, 0), datetime(2026, 11, 3, 0, 0),
        )
        assert local_times(times) == ["Fri 30 08:00", "Sat 31 08:00", "Sun 01 08:00", "Mon 02 08:00"]
        # …which is a different UTC hour on each side of the change.
        assert times[1] == datetime(2026, 10, 31, 15, 0)
        assert times[2] == datetime(2026, 11, 1, 16, 0)

    def test_every_weekday_skips_the_weekend(self):
        times = repeat.occurrences(
            series("weekdays"), LA, datetime(2026, 10, 16, 0, 0), datetime(2026, 10, 22, 0, 0),
        )
        assert local_times(times) == ["Fri 16 08:00", "Mon 19 08:00", "Tue 20 08:00", "Wed 21 08:00"]

    def test_every_week_on_chosen_days(self):
        times = repeat.occurrences(
            series("weekly", ["mon", "thu"]), LA, datetime(2026, 10, 16, 0, 0), datetime(2026, 10, 30, 0, 0),
        )
        assert local_times(times) == ["Mon 19 08:00", "Thu 22 08:00", "Mon 26 08:00", "Thu 29 08:00"]

    def test_nothing_comes_before_the_first_time(self):
        times = repeat.occurrences(
            series("daily"), LA, datetime(2026, 10, 1, 0, 0), datetime(2026, 10, 18, 0, 0),
        )
        assert local_times(times) == ["Fri 16 08:00", "Sat 17 08:00"]

    def test_the_window_is_half_open(self):
        first = datetime(2026, 10, 16, 15, 0)
        times = repeat.occurrences(series("daily"), LA, first, datetime(2026, 10, 17, 15, 0))
        assert times == [first]

    def test_a_reminder_that_does_not_repeat_has_no_occurrences(self):
        assert repeat.occurrences(
            series(None), LA, datetime(2026, 10, 1), datetime(2026, 11, 1),
        ) == []


class TestNeighbours:
    def test_the_next_time_at_or_after_a_moment(self):
        s = series("weekdays")
        # Sat 17 Oct, noon in Los Angeles → Mon 19 Oct, 08:00.
        assert repeat.next_at_or_after(s, LA, datetime(2026, 10, 17, 19, 0)) == datetime(2026, 10, 19, 15, 0)
        # Exactly on a time, that time.
        assert repeat.next_at_or_after(s, LA, datetime(2026, 10, 19, 15, 0)) == datetime(2026, 10, 19, 15, 0)
        # Before the first time, the first time.
        assert repeat.next_at_or_after(s, LA, datetime(2026, 9, 1)) == datetime(2026, 10, 16, 15, 0)

    def test_the_next_time_strictly_after_a_moment(self):
        s = series("daily")
        assert repeat.next_after(s, LA, datetime(2026, 10, 19, 15, 0)) == datetime(2026, 10, 20, 15, 0)

    def test_the_latest_time_at_or_before_a_moment(self):
        s = series("weekly", ["mon"])
        # Thu 22 Oct → Mon 19 Oct, 08:00.
        assert repeat.latest_at_or_before(s, LA, datetime(2026, 10, 22, 20, 0)) == datetime(2026, 10, 19, 15, 0)
        # Before any time has come, none.
        assert repeat.latest_at_or_before(s, LA, datetime(2026, 10, 18, 0, 0)) is None

    def test_whether_an_instant_is_one_of_its_times(self):
        s = series("weekly", ["mon"])
        assert repeat.is_occurrence(s, LA, datetime(2026, 10, 19, 15, 0))
        assert not repeat.is_occurrence(s, LA, datetime(2026, 10, 20, 15, 0))  # a Tuesday
        assert not repeat.is_occurrence(s, LA, datetime(2026, 10, 19, 15, 30))  # not its time
        assert not repeat.is_occurrence(s, LA, datetime(2026, 10, 12, 15, 0))  # before the first


class TestRules:
    @pytest.mark.parametrize("rule,days,expected", [
        ("daily", None, ("daily", None)),
        ("weekdays", [], ("weekdays", None)),
        ("weekly", ["thu", "mon", "mon"], ("weekly", "mon,thu")),
        ("weekly", ["Mon", "FRI"], ("weekly", "mon,fri")),
        (None, None, (None, None)),
        ("none", None, (None, None)),
    ])
    def test_a_rule_is_stored_one_way(self, rule, days, expected):
        assert repeat.normalize(rule, days) == expected

    @pytest.mark.parametrize("rule,days", [
        ("hourly", None),
        ("weekly", None),
        ("weekly", []),
        ("weekly", ["mon", "someday"]),
        ("daily", ["mon"]),
    ])
    def test_what_cannot_repeat_is_refused_with_a_sentence(self, rule, days):
        with pytest.raises(EntryError) as e:
            repeat.normalize(rule, days)
        assert str(e.value).endswith(".")

    @pytest.mark.parametrize("rule,days,words", [
        ("daily", None, "every day at 08:00"),
        ("weekdays", None, "every weekday at 08:00"),
        ("weekly", ["mon", "thu"], "every Monday and Thursday at 08:00"),
        ("weekly", ["mon", "wed", "fri"], "every Monday, Wednesday and Friday at 08:00"),
    ])
    def test_a_rule_in_words(self, rule, days, words):
        assert repeat.describe(series(rule, days), LA) == words
