"""When a task runs (#352): parsing what the assistant asked for, the next run, the label.

Pure functions over ``kurisuassistant.tasks.schedule`` — no database, no clock.
Every "after" handed in is naive UTC, the convention of every other timestamp
column in this schema, and every run time that comes back is too.
"""

from datetime import datetime

import pytest

from kurisuassistant.tasks.schedule import (
    ScheduleError,
    describe,
    first_run,
    next_run,
    parse_schedule,
)


def utc(*parts):
    return datetime(*parts)


class TestParse:
    def test_daily_needs_a_time(self):
        with pytest.raises(ScheduleError, match="time"):
            parse_schedule("daily")

    def test_a_time_must_be_hours_and_minutes(self):
        with pytest.raises(ScheduleError, match="HH:MM"):
            parse_schedule("daily", time="8am")
        with pytest.raises(ScheduleError, match="HH:MM"):
            parse_schedule("daily", time="24:00")

    def test_weekly_needs_days_and_reads_names(self):
        with pytest.raises(ScheduleError, match="days"):
            parse_schedule("weekly", time="20:00")
        schedule = parse_schedule("weekly", time="20:00", days=["Thursday", "mon"])
        assert schedule.days == (0, 3)

    def test_an_unknown_day_is_refused(self):
        with pytest.raises(ScheduleError, match="funday"):
            parse_schedule("weekly", time="20:00", days=["funday"])

    def test_hourly_needs_a_positive_whole_number(self):
        with pytest.raises(ScheduleError, match="every_hours"):
            parse_schedule("hourly")
        with pytest.raises(ScheduleError, match="every_hours"):
            parse_schedule("hourly", every_hours=0)
        assert parse_schedule("hourly", every_hours=3).every_hours == 3

    def test_once_needs_a_date_and_time(self):
        with pytest.raises(ScheduleError, match="at"):
            parse_schedule("once")
        with pytest.raises(ScheduleError, match="at"):
            parse_schedule("once", at="next tuesday")

    def test_an_unknown_timezone_is_refused(self):
        with pytest.raises(ScheduleError, match="Mars/Olympus"):
            parse_schedule("daily", time="08:00", timezone="Mars/Olympus")

    def test_an_unknown_repeat_is_refused(self):
        with pytest.raises(ScheduleError, match="fortnightly"):
            parse_schedule("fortnightly")

    def test_timezone_defaults_to_utc(self):
        assert parse_schedule("daily", time="08:00").timezone == "UTC"


class TestFirstRun:
    def test_now_is_now(self):
        now = utc(2026, 10, 13, 22, 15)
        assert first_run(parse_schedule("now"), now) == now

    def test_once_is_its_moment_in_utc(self):
        schedule = parse_schedule("once", at="2026-10-14T08:00", timezone="Europe/Paris")
        # Paris is UTC+2 in October (summer time until the 25th).
        assert first_run(schedule, utc(2026, 10, 13, 12, 0)) == utc(2026, 10, 14, 6, 0)

    def test_once_in_the_past_is_refused(self):
        schedule = parse_schedule("once", at="2026-10-13T08:00")
        with pytest.raises(ScheduleError, match="passed"):
            first_run(schedule, utc(2026, 10, 13, 12, 0))

    def test_once_with_an_offset_keeps_the_offset(self):
        schedule = parse_schedule("once", at="2026-10-14T08:00:00-07:00")
        assert first_run(schedule, utc(2026, 10, 13, 12, 0)) == utc(2026, 10, 14, 15, 0)

    def test_repeating_is_its_next_run(self):
        schedule = parse_schedule("daily", time="08:00")
        assert first_run(schedule, utc(2026, 10, 13, 7, 0)) == utc(2026, 10, 13, 8, 0)


class TestNextRun:
    def test_one_offs_have_none(self):
        assert next_run(parse_schedule("now"), utc(2026, 10, 13, 12, 0)) is None
        once = parse_schedule("once", at="2026-10-14T08:00")
        assert next_run(once, utc(2026, 10, 14, 8, 0)) is None

    def test_daily_later_today_or_tomorrow(self):
        schedule = parse_schedule("daily", time="08:00")
        assert next_run(schedule, utc(2026, 10, 13, 7, 59)) == utc(2026, 10, 13, 8, 0)
        # Strictly after: a run that started at 08:00 is followed by tomorrow's.
        assert next_run(schedule, utc(2026, 10, 13, 8, 0)) == utc(2026, 10, 14, 8, 0)

    def test_daily_in_a_timezone(self):
        # 07:30 in Los Angeles is 14:30 UTC in October (PDT, UTC-7).
        schedule = parse_schedule("daily", time="07:30", timezone="America/Los_Angeles")
        assert next_run(schedule, utc(2026, 10, 13, 15, 0)) == utc(2026, 10, 14, 14, 30)

    def test_daily_keeps_local_time_across_a_clock_change(self):
        # Europe/Paris leaves summer time on Sunday 25 October 2026.
        schedule = parse_schedule("daily", time="08:00", timezone="Europe/Paris")
        assert next_run(schedule, utc(2026, 10, 24, 7, 0)) == utc(2026, 10, 25, 7, 0)
        assert next_run(schedule, utc(2026, 10, 25, 7, 0)) == utc(2026, 10, 26, 7, 0)

    def test_weekdays_skip_the_weekend(self):
        schedule = parse_schedule("weekdays", time="07:30")
        # Friday 16 October 2026, after the run: next is Monday.
        assert next_run(schedule, utc(2026, 10, 16, 8, 0)) == utc(2026, 10, 19, 7, 30)

    def test_weekly_picks_the_next_listed_day(self):
        schedule = parse_schedule("weekly", time="20:00", days=["mon", "thu"])
        # Tuesday 13 October → Thursday 15th.
        assert next_run(schedule, utc(2026, 10, 13, 12, 0)) == utc(2026, 10, 15, 20, 0)
        # Thursday after the run → next Monday.
        assert next_run(schedule, utc(2026, 10, 15, 20, 0)) == utc(2026, 10, 19, 20, 0)

    def test_hourly_counts_from_the_run(self):
        schedule = parse_schedule("hourly", every_hours=3)
        assert next_run(schedule, utc(2026, 10, 13, 12, 5)) == utc(2026, 10, 13, 15, 5)


class TestDescribe:
    @pytest.mark.parametrize(
        ("kwargs", "label"),
        [
            ({"repeat": "now"}, "Right away"),
            ({"repeat": "daily", "time": "08:00"}, "Every day at 08:00"),
            ({"repeat": "weekdays", "time": "07:30"}, "Weekdays at 07:30"),
            ({"repeat": "weekly", "time": "20:00", "days": ["sun"]}, "Sundays at 20:00"),
            ({"repeat": "weekly", "time": "20:00", "days": ["thu", "mon"]}, "Mondays and Thursdays at 20:00"),
            (
                {"repeat": "weekly", "time": "09:00", "days": ["mon", "wed", "fri"]},
                "Mondays, Wednesdays and Fridays at 09:00",
            ),
            ({"repeat": "hourly", "every_hours": 1}, "Every hour"),
            ({"repeat": "hourly", "every_hours": 3}, "Every 3 hours"),
            ({"repeat": "once", "at": "2026-12-04T09:00"}, "Once · Friday 4 December 2026, 09:00"),
        ],
    )
    def test_labels(self, kwargs, label):
        repeat = kwargs.pop("repeat")
        assert describe(parse_schedule(repeat, **kwargs)) == label

    def test_a_timezone_other_than_utc_is_named(self):
        schedule = parse_schedule("daily", time="08:00", timezone="Europe/Paris")
        assert describe(schedule) == "Every day at 08:00 (Europe/Paris)"
