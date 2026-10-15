"""The calendar's REST surface (#282), through the real app and database.

Events and reminders are the user's own record: the clients create, move, mark
done and delete them here, and an entry of another account is 404 — never 403 —
exactly as the drive answers.
"""

import uuid

import pytest

from tests.conftest import Account, _create_activated_user, _set_ollama_url

pytestmark = pytest.mark.db


@pytest.fixture()
def other(system_client, mock_ollama):
    username = f"cal-other-{uuid.uuid4().hex[:10]}"
    _create_activated_user(username, "other-password")
    _set_ollama_url(username, mock_ollama.url)
    return Account(system_client, username, "other-password")


def create(account, **body):
    return account.client.post("/calendar/entries", json=body, headers=account.headers)


def reminder(account, title="Call Mom", at="2026-10-17T02:00:00Z"):
    resp = create(account, kind="reminder", title=title, starts_at=at)
    assert resp.status_code == 201, resp.text
    return resp.json()


class TestCreate:
    def test_a_reminder_is_an_instant(self, account):
        body = reminder(account)
        assert body["kind"] == "reminder"
        assert body["title"] == "Call Mom"
        assert body["starts_at"] == "2026-10-17T02:00:00Z"
        assert body["ends_at"] is None
        assert body["all_day"] is False
        assert body["done"] is False
        # Nothing says who set it: the calendar is the user's, whoever typed it.
        assert not {"source", "created_by", "persona_id", "conversation_id"} & set(body)

    def test_an_offset_is_converted_to_utc(self, account):
        resp = create(account, kind="reminder", title="Water the plants", starts_at="2026-10-12T08:00:00-07:00")
        assert resp.json()["starts_at"] == "2026-10-12T15:00:00Z"

    def test_a_timed_event_without_an_end_lasts_an_hour(self, account):
        resp = create(account, kind="event", title="Dentist", starts_at="2026-10-12T16:30:00Z")
        assert resp.status_code == 201, resp.text
        assert resp.json()["ends_at"] == "2026-10-12T17:30:00Z"

    def test_an_all_day_event_is_dates(self, account):
        resp = create(account, kind="event", title="Linh's birthday", all_day=True, start_date="2026-10-18")
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["all_day"] is True
        assert body["start_date"] == "2026-10-18"
        assert body["end_date"] == "2026-10-18"
        assert body["starts_at"] is None

    @pytest.mark.parametrize(
        "body",
        [
            {"kind": "reminder", "title": "No time"},
            {"kind": "reminder", "title": "All day", "all_day": True, "start_date": "2026-10-18"},
            {"kind": "event", "title": "Backwards", "starts_at": "2026-10-12T17:00:00Z", "ends_at": "2026-10-12T16:00:00Z"},
            {"kind": "event", "title": "No date", "all_day": True},
            {"kind": "event", "title": "Bad range", "all_day": True, "start_date": "2026-10-18", "end_date": "2026-10-17"},
            {"kind": "event", "title": "   ", "starts_at": "2026-10-12T16:00:00Z"},
            {"kind": "task", "title": "Not a kind", "starts_at": "2026-10-12T16:00:00Z"},
            {"kind": "event", "title": "x" * 201, "starts_at": "2026-10-12T16:00:00Z"},
        ],
    )
    def test_what_cannot_be_on_a_calendar_is_refused_with_a_sentence(self, account, body):
        resp = create(account, **body)
        assert resp.status_code in (400, 422), resp.text
        assert resp.json()["detail"]
        assert account.client.get("/calendar/upcoming", headers=account.headers).json() == []


class TestReadAndOwnership:
    def test_get_patch_delete_are_404_for_another_account(self, account, other):
        theirs = reminder(other)
        for method in ("get", "patch", "delete"):
            kwargs = {"json": {"title": "mine now"}} if method == "patch" else {}
            resp = getattr(account.client, method)(
                f"/calendar/entries/{theirs['id']}", headers=account.headers, **kwargs
            )
            assert resp.status_code == 404, method
        assert other.client.get(f"/calendar/entries/{theirs['id']}", headers=other.headers).json()["title"] == "Call Mom"

    def test_the_window_lists_what_overlaps_it_and_nothing_of_anyone_else(self, account, other):
        reminder(other, title="Not yours", at="2026-10-14T10:00:00Z")
        inside = reminder(account, title="Inside", at="2026-10-14T10:00:00Z")
        reminder(account, title="Outside", at="2026-10-25T10:00:00Z")
        spanning = create(
            account, kind="event", title="Spans the start",
            starts_at="2026-10-11T23:00:00Z", ends_at="2026-10-12T01:00:00Z",
        ).json()
        birthday = create(account, kind="event", title="Birthday", all_day=True, start_date="2026-10-18").json()

        resp = account.client.get(
            "/calendar/entries",
            params={"start": "2026-10-12T00:00:00Z", "end": "2026-10-19T00:00:00Z"},
            headers=account.headers,
        )
        assert resp.status_code == 200, resp.text
        ids = {e["id"] for e in resp.json()}
        assert ids == {inside["id"], spanning["id"], birthday["id"]}

    def test_a_window_needs_both_ends_and_a_sane_length(self, account):
        assert account.client.get("/calendar/entries", headers=account.headers).status_code == 422
        resp = account.client.get(
            "/calendar/entries",
            params={"start": "2026-01-01T00:00:00Z", "end": "2028-01-01T00:00:00Z"},
            headers=account.headers,
        )
        assert resp.status_code == 400

    def test_upcoming_is_in_order_and_leaves_done_and_past_out(self, account):
        from datetime import datetime, timedelta

        soon = (datetime.utcnow() + timedelta(days=1)).replace(microsecond=0).isoformat() + "Z"
        later = (datetime.utcnow() + timedelta(days=3)).replace(microsecond=0).isoformat() + "Z"
        past = (datetime.utcnow() - timedelta(days=3)).replace(microsecond=0).isoformat() + "Z"
        b = reminder(account, title="Later", at=later)
        a = reminder(account, title="Soon", at=soon)
        reminder(account, title="Past", at=past)
        done = reminder(account, title="Done already", at=soon)
        account.client.patch(f"/calendar/entries/{done['id']}", json={"done": True}, headers=account.headers)

        titles = [e["title"] for e in account.client.get("/calendar/upcoming", headers=account.headers).json()]
        assert titles == [a["title"], b["title"]]


class TestChange:
    def test_moving_a_reminder_makes_it_due_again(self, account):
        entry = reminder(account)
        self._mark_delivered(entry["id"])

        resp = account.client.patch(
            f"/calendar/entries/{entry['id']}", json={"starts_at": "2026-10-18T02:00:00Z"}, headers=account.headers,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["starts_at"] == "2026-10-18T02:00:00Z"
        assert self._delivered_at(entry["id"]) is None

    def test_done_and_undone(self, account):
        entry = reminder(account)
        done = account.client.patch(f"/calendar/entries/{entry['id']}", json={"done": True}, headers=account.headers).json()
        assert done["done"] is True and done["done_at"]
        undone = account.client.patch(f"/calendar/entries/{entry['id']}", json={"done": False}, headers=account.headers).json()
        assert undone["done"] is False and undone["done_at"] is None

    def test_only_a_reminder_can_be_done(self, account):
        event = create(account, kind="event", title="Lunch", starts_at="2026-10-13T19:00:00Z").json()
        resp = account.client.patch(f"/calendar/entries/{event['id']}", json={"done": True}, headers=account.headers)
        assert resp.status_code == 400

    def test_a_move_that_breaks_the_entry_changes_nothing(self, account):
        event = create(
            account, kind="event", title="Lunch",
            starts_at="2026-10-13T19:00:00Z", ends_at="2026-10-13T20:00:00Z",
        ).json()
        resp = account.client.patch(
            f"/calendar/entries/{event['id']}", json={"ends_at": "2026-10-13T18:00:00Z"}, headers=account.headers,
        )
        assert resp.status_code == 400
        assert account.client.get(f"/calendar/entries/{event['id']}", headers=account.headers).json()["ends_at"] == "2026-10-13T20:00:00Z"

    def test_delete(self, account):
        entry = reminder(account)
        assert account.client.delete(f"/calendar/entries/{entry['id']}", headers=account.headers).status_code == 204
        assert account.client.get(f"/calendar/entries/{entry['id']}", headers=account.headers).status_code == 404

    @staticmethod
    def _mark_delivered(entry_id):
        from datetime import datetime

        from kurisuassistant.db.models import CalendarEntry
        from kurisuassistant.db.session import get_session

        with get_session() as session:
            session.get(CalendarEntry, entry_id).delivered_at = datetime.utcnow()

    @staticmethod
    def _delivered_at(entry_id):
        from kurisuassistant.db.models import CalendarEntry
        from kurisuassistant.db.session import get_session

        with get_session() as session:
            return session.get(CalendarEntry, entry_id).delivered_at
