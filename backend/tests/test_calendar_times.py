"""Calendar time handling (#282), without a database.

The calendar stores instants in UTC and all-day entries as plain dates. What a
person types — and what the assistant passes on for them — is wall-clock time
in their own zone, so the conversion in ``calendar/times.py`` is where "remind
me at 7 on Friday" becomes the right instant. A zone the server does not know
falls back to UTC rather than failing the call.
"""

from datetime import date, datetime

import pytest

from kurisuassistant.calendar import times


LA = "America/Los_Angeles"


class TestZone:
    def test_a_known_zone_is_used(self):
        assert times.zone(LA).key == LA

    @pytest.mark.parametrize("name", [None, "", "Not/AZone", "../../etc/passwd"])
    def test_anything_else_is_utc(self, name):
        assert times.zone(name).key == "UTC"

    def test_is_valid_zone(self):
        assert times.is_valid_zone(LA)
        assert times.is_valid_zone("UTC")
        assert not times.is_valid_zone("Mars/Olympus_Mons")
        assert not times.is_valid_zone("")


class TestParseLocal:
    def test_wall_time_is_read_in_the_users_zone(self):
        # 19:00 on 16 Oct 2026 in Los Angeles (PDT, UTC-7) is 02:00 UTC the next day.
        parsed = times.parse_local("2026-10-16T19:00", times.zone(LA))
        assert parsed == datetime(2026, 10, 17, 2, 0)
        assert parsed.tzinfo is None  # stored naive UTC, like every other column

    def test_a_space_separates_date_and_time_too(self):
        assert times.parse_local("2026-10-16 19:00", times.zone(LA)) == datetime(2026, 10, 17, 2, 0)

    def test_an_explicit_offset_wins_over_the_zone(self):
        assert times.parse_local("2026-10-16T19:00+02:00", times.zone(LA)) == datetime(2026, 10, 16, 17, 0)
        assert times.parse_local("2026-10-16T19:00Z", times.zone(LA)) == datetime(2026, 10, 16, 19, 0)

    def test_a_date_alone_is_a_date(self):
        assert times.parse_local("2026-10-18", times.zone(LA)) == date(2026, 10, 18)

    @pytest.mark.parametrize("value", [None, "", "Friday", "2026-13-01", "19:00", 42])
    def test_nonsense_is_refused_with_a_sentence(self, value):
        with pytest.raises(ValueError) as excinfo:
            times.parse_local(value, times.zone(LA))
        assert str(excinfo.value)  # something a model can read and correct


class TestParseInstant:
    """What the REST API takes: an instant, ideally with its offset."""

    def test_z_and_offsets(self):
        assert times.parse_instant("2026-10-17T02:00:00Z") == datetime(2026, 10, 17, 2, 0)
        assert times.parse_instant("2026-10-16T19:00:00-07:00") == datetime(2026, 10, 17, 2, 0)

    def test_naive_is_utc(self):
        assert times.parse_instant("2026-10-17T02:00:00") == datetime(2026, 10, 17, 2, 0)


class TestFormat:
    def test_wire_form_is_utc_with_z(self):
        assert times.to_wire(datetime(2026, 10, 17, 2, 0)) == "2026-10-17T02:00:00Z"
        assert times.to_wire(None) is None

    def test_local_form_reads_like_a_calendar(self):
        assert times.format_local(datetime(2026, 10, 17, 2, 0), times.zone(LA)) == "Fri 16 Oct 2026, 19:00"

    def test_local_date(self):
        assert times.format_date(date(2026, 10, 18)) == "Sun 18 Oct 2026"


class TestZoneFor:
    """The calendar's one zone lookup. UTC until the account setting arrives
    with #352, when it becomes ``core.timezone.user_timezone``."""

    def test_everyone_is_utc_for_now(self):
        from kurisuassistant.calendar import zone

        assert zone.zone_for(None).key == "UTC"
        assert zone.zone_for(object()).key == "UTC"
