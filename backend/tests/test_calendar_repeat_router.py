"""Repeating reminders over REST (#355), through the real app and database.

A reminder can repeat every day, every weekday, or every week on chosen days,
at the same time on the user's clock. The calendar shows each time on its day;
marking one done leaves the others; the repeat can be changed or stopped.

The account is pinned to Los Angeles through ``calendar/zone.zone_for``, the
calendar's one zone lookup. Fri 16 Oct 2026, 08:00 there is 15:00 UTC.
"""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

pytestmark = pytest.mark.db

LA = ZoneInfo("America/Los_Angeles")
FIRST = "2026-10-16T15:00:00Z"  # Fri 16 Oct 2026, 08:00 in Los Angeles


@pytest.fixture(autouse=True)
def in_los_angeles(monkeypatch):
    from kurisuassistant.calendar import zone

    monkeypatch.setattr(zone, "zone_for", lambda user: LA)


def create(account, **body):
    return account.client.post("/calendar/entries", json=body, headers=account.headers)


def repeating(account, rule="daily", days=None, at=FIRST, title="Take the pills"):
    body = {"kind": "reminder", "title": title, "starts_at": at, "repeat": rule}
    if days is not None:
        body["repeat_days"] = days
    resp = create(account, **body)
    assert resp.status_code == 201, resp.text
    return resp.json()


def window(account, start, end):
    resp = account.client.get("/calendar/entries", params={"start": start, "end": end}, headers=account.headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def patch(account, entry_id, **body):
    return account.client.patch(f"/calendar/entries/{entry_id}", json=body, headers=account.headers)


def wire(instant: datetime) -> str:
    return instant.replace(microsecond=0).isoformat() + "Z"


def local(value: str) -> str:
    instant = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return instant.astimezone(LA).strftime("%a %d %H:%M")


class TestCreate:
    def test_a_reminder_can_repeat(self, account):
        body = repeating(account, "weekly", ["thu", "mon"])
        assert body["repeat"] == "weekly"
        assert body["repeat_days"] == ["mon", "thu"]
        assert body["repeat_from"] == FIRST

    def test_one_that_does_not_repeat_says_so(self, account):
        body = create(account, kind="reminder", title="Once", starts_at=FIRST).json()
        assert body["repeat"] is None
        assert body["repeat_days"] == []
        assert body["repeat_from"] is None

    @pytest.mark.parametrize("body", [
        {"kind": "event", "title": "Standup", "starts_at": FIRST, "repeat": "daily"},
        {"kind": "reminder", "title": "Weekly on no day", "starts_at": FIRST, "repeat": "weekly"},
        {"kind": "reminder", "title": "Hourly", "starts_at": FIRST, "repeat": "hourly"},
        {"kind": "reminder", "title": "Bad day", "starts_at": FIRST, "repeat": "weekly", "repeat_days": ["funday"]},
    ])
    def test_what_cannot_repeat_is_refused_with_a_sentence(self, account, body):
        resp = create(account, **body)
        assert resp.status_code == 400, resp.text
        assert resp.json()["detail"].endswith(".")


class TestTheCalendarShowsEachTime:
    def test_each_time_in_the_window_is_on_its_day(self, account):
        entry = repeating(account, "daily")
        # Thu 29 Oct to Tue 3 Nov — across the clock change on Sun 1 Nov.
        items = window(account, "2026-10-29T07:00:00Z", "2026-11-03T08:00:00Z")
        mine = [i for i in items if i["id"] == entry["id"]]
        assert [local(i["starts_at"]) for i in mine] == [
            "Thu 29 08:00", "Fri 30 08:00", "Sat 31 08:00", "Sun 01 08:00", "Mon 02 08:00",
        ]
        assert all(i["repeat"] == "daily" and i["repeat_from"] == FIRST for i in mine)
        assert all(i["done"] is False for i in mine)

    def test_every_weekday_and_every_week(self, account):
        weekdays = repeating(account, "weekdays", title="Stand up")
        weekly = repeating(account, "weekly", ["sat"], title="Bins out")
        items = window(account, "2026-10-17T07:00:00Z", "2026-10-24T07:00:00Z")  # Sat 17 – Fri 23
        assert [local(i["starts_at"]) for i in items if i["id"] == weekdays["id"]] == [
            "Mon 19 08:00", "Tue 20 08:00", "Wed 21 08:00", "Thu 22 08:00", "Fri 23 08:00",
        ]
        assert [local(i["starts_at"]) for i in items if i["id"] == weekly["id"]] == ["Sat 17 08:00"]

    def test_nothing_before_the_first_time(self, account):
        entry = repeating(account, "daily")
        items = window(account, "2026-10-01T00:00:00Z", "2026-10-16T00:00:00Z")
        assert not [i for i in items if i["id"] == entry["id"]]

    def test_coming_up_lists_the_next_times_and_leaves_a_done_one_out(self, account):
        start = datetime.utcnow().replace(second=0, microsecond=0) + timedelta(hours=1)
        entry = repeating(account, "daily", at=wire(start))
        upcoming = account.client.get("/calendar/upcoming", params={"limit": 3}, headers=account.headers).json()
        times = [i["starts_at"] for i in upcoming if i["id"] == entry["id"]]
        assert times == [wire(start), wire(start + timedelta(days=1)), wire(start + timedelta(days=2))]

        assert patch(account, entry["id"], done=True, occurrence_at=wire(start)).status_code == 200
        upcoming = account.client.get("/calendar/upcoming", params={"limit": 3}, headers=account.headers).json()
        assert [i["starts_at"] for i in upcoming if i["id"] == entry["id"]][0] == wire(start + timedelta(days=1))

    def test_opening_one_shows_its_time_from_today_on(self, account):
        # Started a week ago: what opens is today's time or the next, never the first.
        start = datetime.utcnow().replace(second=0, microsecond=0) - timedelta(days=7)
        entry = repeating(account, "daily", at=wire(start))
        body = account.client.get(f"/calendar/entries/{entry['id']}", headers=account.headers).json()
        shown = datetime.fromisoformat(body["starts_at"].replace("Z", ""))
        today = datetime.utcnow().replace(tzinfo=ZoneInfo("UTC")).astimezone(LA).date()
        assert shown.replace(tzinfo=ZoneInfo("UTC")).astimezone(LA).date() >= today
        assert body["repeat_from"] == wire(start)


class TestDoneIsPerTime:
    def test_marking_one_time_done_leaves_the_others(self, account):
        entry = repeating(account, "daily")
        saturday = "2026-10-17T15:00:00Z"
        resp = patch(account, entry["id"], done=True, occurrence_at=saturday)
        assert resp.status_code == 200, resp.text
        assert resp.json()["starts_at"] == saturday and resp.json()["done"] is True

        items = [i for i in window(account, "2026-10-16T07:00:00Z", "2026-10-19T07:00:00Z") if i["id"] == entry["id"]]
        assert [(local(i["starts_at"]), i["done"]) for i in items] == [
            ("Fri 16 08:00", False), ("Sat 17 08:00", True), ("Sun 18 08:00", False),
        ]

        assert patch(account, entry["id"], done=False, occurrence_at=saturday).json()["done"] is False

    def test_done_must_say_which_time(self, account):
        entry = repeating(account, "daily")
        resp = patch(account, entry["id"], done=True)
        assert resp.status_code == 400
        assert resp.json()["detail"].endswith(".")

    def test_a_time_that_is_not_one_of_its_times_is_refused(self, account):
        entry = repeating(account, "weekly", ["mon"])
        resp = patch(account, entry["id"], done=True, occurrence_at="2026-10-20T15:00:00Z")  # a Tuesday
        assert resp.status_code == 400


class TestChangeAndStop:
    def test_the_repeat_can_be_changed(self, account):
        entry = repeating(account, "daily")
        resp = patch(account, entry["id"], repeat="weekly", repeat_days=["wed"])
        assert resp.status_code == 200, resp.text
        assert resp.json()["repeat"] == "weekly" and resp.json()["repeat_days"] == ["wed"]
        items = [i for i in window(account, "2026-10-16T07:00:00Z", "2026-10-30T07:00:00Z") if i["id"] == entry["id"]]
        assert [local(i["starts_at"]) for i in items] == ["Wed 21 08:00", "Wed 28 08:00"]

    def test_moving_the_time_moves_every_time(self, account):
        entry = repeating(account, "daily")
        resp = patch(account, entry["id"], starts_at="2026-10-16T16:30:00Z")  # 09:30
        assert resp.status_code == 200, resp.text
        items = [i for i in window(account, "2026-10-16T07:00:00Z", "2026-10-18T07:00:00Z") if i["id"] == entry["id"]]
        assert [local(i["starts_at"]) for i in items] == ["Fri 16 09:30", "Sat 17 09:30"]

    def test_stopping_the_repeat_leaves_one_reminder_that_does_not_come_back(self, account):
        start = datetime.utcnow().replace(second=0, microsecond=0) - timedelta(days=3)
        entry = repeating(account, "daily", at=wire(start))
        resp = patch(account, entry["id"], repeat=None)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["repeat"] is None and body["repeat_from"] is None
        # It is the latest time that came, so it does not notify again.
        assert datetime.fromisoformat(body["starts_at"].replace("Z", "")) <= datetime.utcnow()
        assert self._delivered_at(entry["id"]) is not None
        ahead = window(account, wire(datetime.utcnow()), wire(datetime.utcnow() + timedelta(days=10)))
        assert not [i for i in ahead if i["id"] == entry["id"]]

    def test_a_reminder_can_start_repeating(self, account):
        once = create(account, kind="reminder", title="Water the plants", starts_at=FIRST).json()
        resp = patch(account, once["id"], repeat="weekly", repeat_days=["fri"])
        assert resp.status_code == 200, resp.text
        items = [i for i in window(account, "2026-10-16T07:00:00Z", "2026-10-31T07:00:00Z") if i["id"] == once["id"]]
        assert [local(i["starts_at"]) for i in items] == ["Fri 16 08:00", "Fri 23 08:00", "Fri 30 08:00"]

    def test_an_event_cannot_start_repeating(self, account):
        event = create(account, kind="event", title="Lunch", starts_at=FIRST).json()
        assert patch(account, event["id"], repeat="daily").status_code == 400

    def test_deleting_removes_every_time(self, account):
        entry = repeating(account, "daily")
        assert account.client.delete(f"/calendar/entries/{entry['id']}", headers=account.headers).status_code == 204
        assert not [i for i in window(account, "2026-10-16T07:00:00Z", "2026-10-23T07:00:00Z") if i["id"] == entry["id"]]

    @staticmethod
    def _delivered_at(entry_id):
        from kurisuassistant.db.models import CalendarEntry
        from kurisuassistant.db.session import get_session

        with get_session() as session:
            return session.get(CalendarEntry, entry_id).delivered_at
