"""A repeating reminder notifies at each of its times (#355).

The scanner keeps one cursor per repeating reminder, ``next_due_at``: when it
comes due the time is delivered like a one-off reminder and the cursor moves to
the next time. A time marked done in advance is not delivered. A server that
was down for days sends one notification for the latest time it missed, not
one for each. A delivery that fails is tried again for the same time.

``delivery.deliver`` is patched and one scan is run by hand, as in
``test_calendar_reminders.py``. Needs Postgres.
"""

import uuid
from datetime import datetime, timedelta

import pytest

from kurisuassistant.calendar import delivery
from kurisuassistant.workers import reminders

pytestmark = pytest.mark.db


@pytest.fixture()
def user_id(system_client, monkeypatch):
    from zoneinfo import ZoneInfo

    from kurisuassistant.calendar import zone
    from kurisuassistant.core.accounts import provision_user
    from kurisuassistant.core.security import hash_password
    from kurisuassistant.db.repositories import UserRepository
    from kurisuassistant.db.session import get_session

    with get_session() as session:
        user = UserRepository(session).create_user(f"cal-rep-{uuid.uuid4().hex[:8]}", hash_password("x"))
        provision_user(session, user)
        user.is_active = True
        session.flush()
        made = user.id
    # UTC, so "a day later" is 24 hours whenever this runs; the clock change is
    # test_calendar_repeat.py's to cover.
    monkeypatch.setattr(zone, "zone_for", lambda user: ZoneInfo("UTC"))
    return made


@pytest.fixture()
def delivered(monkeypatch):
    calls = []

    async def fake_deliver(entry):
        calls.append(entry)

    monkeypatch.setattr(delivery, "deliver", fake_deliver)
    return calls


def _minute(value: datetime) -> datetime:
    return value.replace(second=0, microsecond=0)


def _series(user_id, *, first, next_due=None, title="Take the pills"):
    from kurisuassistant.db.models import CalendarEntry
    from kurisuassistant.db.session import get_session

    with get_session() as session:
        row = CalendarEntry(
            user_id=user_id, kind="reminder", title=title, starts_at=first,
            repeat="daily", next_due_at=next_due or first,
        )
        session.add(row)
        session.flush()
        return row.id


def _done(entry_id, at):
    from kurisuassistant.db.models import CalendarOccurrence
    from kurisuassistant.db.session import get_session

    with get_session() as session:
        session.add(CalendarOccurrence(entry_id=entry_id, occurs_at=at, done_at=datetime.utcnow()))


def _row(entry_id):
    from kurisuassistant.db.models import CalendarEntry
    from kurisuassistant.db.session import get_session

    with get_session() as session:
        row = session.get(CalendarEntry, entry_id)
        return {
            "next_due_at": row.next_due_at,
            "delivered_at": row.delivered_at,
            "attempts": row.delivery_attempts,
        }


def _mine(calls, entry_id):
    return [c for c in calls if c["id"] == entry_id]


async def test_each_time_is_delivered_once_and_the_next_one_waits(user_id, delivered):
    now = _minute(datetime.utcnow())
    first = now - timedelta(minutes=1)
    entry = _series(user_id, first=first)

    await reminders.scan_once(now)
    await reminders.scan_once(now)

    [sent] = _mine(delivered, entry)
    assert sent["starts_at"] == first
    assert sent["title"] == "Take the pills"
    assert _row(entry)["next_due_at"] == first + timedelta(days=1)

    await reminders.scan_once(now + timedelta(days=1))
    assert [c["starts_at"] for c in _mine(delivered, entry)] == [first, first + timedelta(days=1)]
    # The one-off bookkeeping is never stamped: every time comes.
    assert _row(entry)["delivered_at"] is None


async def test_a_time_done_in_advance_does_not_notify_and_the_rest_still_do(user_id, delivered):
    now = _minute(datetime.utcnow())
    first = now - timedelta(minutes=1)
    entry = _series(user_id, first=first)
    _done(entry, first)

    await reminders.scan_once(now)
    assert _mine(delivered, entry) == []
    assert _row(entry)["next_due_at"] == first + timedelta(days=1)

    await reminders.scan_once(now + timedelta(days=1))
    assert [c["starts_at"] for c in _mine(delivered, entry)] == [first + timedelta(days=1)]


async def test_days_missed_while_the_server_was_down_notify_once(user_id, delivered):
    now = _minute(datetime.utcnow())
    first = now - timedelta(days=3, minutes=1)
    entry = _series(user_id, first=first)

    await reminders.scan_once(now)

    [sent] = _mine(delivered, entry)
    assert sent["starts_at"] == first + timedelta(days=3)
    assert _row(entry)["next_due_at"] == first + timedelta(days=4)


async def test_a_failed_delivery_is_tried_again_for_the_same_time(user_id, monkeypatch):
    attempts = []

    async def failing(entry):
        attempts.append(entry)
        raise RuntimeError("no device reachable")

    monkeypatch.setattr(delivery, "deliver", failing)
    now = _minute(datetime.utcnow())
    first = now - timedelta(minutes=1)
    entry = _series(user_id, first=first)

    await reminders.scan_once(now)
    assert _row(entry)["next_due_at"] == first, "a failure must not skip the time"
    assert _row(entry)["attempts"] == 1

    sent = []

    async def working(entry):
        sent.append(entry)

    monkeypatch.setattr(delivery, "deliver", working)
    await reminders.scan_once(now)
    assert [c["starts_at"] for c in _mine(sent, entry)] == [first]
    assert _row(entry) == {"next_due_at": first + timedelta(days=1), "delivered_at": None, "attempts": 0}


async def test_a_time_that_keeps_failing_is_given_up_and_the_series_goes_on(user_id, monkeypatch, caplog):
    async def failing(entry):
        raise RuntimeError("no device reachable")

    monkeypatch.setattr(delivery, "deliver", failing)
    now = _minute(datetime.utcnow())
    first = now - timedelta(minutes=1)
    entry = _series(user_id, first=first)

    for _ in range(reminders.MAX_DELIVERY_ATTEMPTS):
        await reminders.scan_once(now)

    assert _row(entry) == {"next_due_at": first + timedelta(days=1), "delivered_at": None, "attempts": 0}
    assert any("giving up" in r.getMessage() for r in caplog.records)


async def test_a_repeating_reminder_is_not_delivered_by_its_first_time(user_id, delivered):
    """Its ``starts_at`` is in the past, but its next time is not: the one-off
    path must not deliver it."""
    now = _minute(datetime.utcnow())
    entry = _series(user_id, first=now - timedelta(days=2), next_due=now + timedelta(hours=3))

    await reminders.scan_once(now)

    assert _mine(delivered, entry) == []
