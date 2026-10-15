"""A reminder's notification follows the reminder (#282, #353).

A due reminder is delivered through ``notifications.notify`` — stored with the
reminder's id and read on every device at once. When the user is done with the
reminder, moves it or deletes it, its notification is read for them: it is not
left on a phone asking about something already handled.

Needs Postgres (``POSTGRES_HOST``/``POSTGRES_PORT``; CI provides one).
"""

from datetime import datetime, timedelta

import pytest

from kurisuassistant.workers import reminders

pytestmark = pytest.mark.db


def due_reminder(account, title):
    at = (datetime.utcnow() - timedelta(minutes=1)).replace(microsecond=0).isoformat() + "Z"
    resp = account.client.post(
        "/calendar/entries", json={"kind": "reminder", "title": title, "starts_at": at},
        headers=account.headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def unread_for(account, entry_id):
    resp = account.client.get("/notifications", params={"unread": "true"}, headers=account.headers)
    assert resp.status_code == 200, resp.text
    return [n for n in resp.json()["notifications"] if n["reminder_id"] == entry_id]


async def delivered(account, entry_id):
    await reminders.scan_once()
    [shown] = unread_for(account, entry_id)
    return shown


class TestDelivery:
    async def test_a_due_reminder_is_a_calendar_notification(self, account):
        entry_id = due_reminder(account, "Call Mom")

        shown = await delivered(account, entry_id)

        assert shown["source"] == "calendar"
        assert shown["sender"] == "Calendar"
        assert shown["title"] == "Call Mom"
        assert shown["body"].startswith("Due at ")


class TestTheNotificationFollowsTheReminder:
    async def test_done_reads_it(self, account):
        entry_id = due_reminder(account, "Take the bins out")
        await delivered(account, entry_id)

        resp = account.client.patch(f"/calendar/entries/{entry_id}", json={"done": True}, headers=account.headers)
        assert resp.status_code == 200, resp.text

        assert unread_for(account, entry_id) == []

    async def test_moving_it_reads_it(self, account):
        entry_id = due_reminder(account, "Water the plants")
        await delivered(account, entry_id)

        later = (datetime.utcnow() + timedelta(hours=2)).replace(microsecond=0).isoformat() + "Z"
        resp = account.client.patch(
            f"/calendar/entries/{entry_id}", json={"starts_at": later}, headers=account.headers,
        )
        assert resp.status_code == 200, resp.text

        assert unread_for(account, entry_id) == []

    async def test_deleting_it_reads_it(self, account):
        entry_id = due_reminder(account, "Renew the passport")
        await delivered(account, entry_id)

        resp = account.client.delete(f"/calendar/entries/{entry_id}", headers=account.headers)
        assert resp.status_code == 204, resp.text

        assert unread_for(account, entry_id) == []

    async def test_renaming_it_leaves_it(self, account):
        entry_id = due_reminder(account, "Pay rent")
        await delivered(account, entry_id)

        resp = account.client.patch(
            f"/calendar/entries/{entry_id}", json={"title": "Pay the rent"}, headers=account.headers,
        )
        assert resp.status_code == 200, resp.text

        assert len(unread_for(account, entry_id)) == 1
