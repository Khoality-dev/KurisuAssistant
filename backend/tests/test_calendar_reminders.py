"""Due reminders reach the user once (#282).

The scanner finds reminders whose time has come, claims each one, and hands it
to ``calendar.delivery.deliver`` — which calls the notifications module (#353).
These tests patch ``deliver`` and run one scan by hand, so they cover what the
calendar owns: which reminders are due, that each is delivered exactly once, and
that a delivery that fails is tried again rather than lost.

Needs Postgres (``POSTGRES_HOST``/``POSTGRES_PORT``; CI provides one).
"""

import uuid
from datetime import datetime, timedelta

import pytest

from kurisuassistant.calendar import delivery
from kurisuassistant.workers import reminders

pytestmark = pytest.mark.db


@pytest.fixture()
def user_id(system_client, monkeypatch):
    from kurisuassistant.core.accounts import provision_user
    from kurisuassistant.core.security import hash_password
    from kurisuassistant.db.repositories import UserRepository
    from kurisuassistant.db.session import get_session

    with get_session() as session:
        user = UserRepository(session).create_user(f"cal-due-{uuid.uuid4().hex[:8]}", hash_password("x"))
        provision_user(session, user)
        user.is_active = True
        session.flush()
        made = user.id
    # The account's zone, as calendar/zone.zone_for reads it.
    from zoneinfo import ZoneInfo

    from kurisuassistant.calendar import zone

    monkeypatch.setattr(zone, "zone_for", lambda user: ZoneInfo("America/Los_Angeles"))
    return made


@pytest.fixture()
def delivered(monkeypatch):
    calls = []

    async def fake_deliver(entry):
        calls.append(entry)

    monkeypatch.setattr(delivery, "deliver", fake_deliver)
    return calls


def _entry(user_id, title, *, at, kind="reminder", done=False):
    from kurisuassistant.db.models import CalendarEntry
    from kurisuassistant.db.session import get_session

    with get_session() as session:
        row = CalendarEntry(
            user_id=user_id, kind=kind, title=title, starts_at=at,
            ends_at=at + timedelta(hours=1) if kind == "event" else None,
            done_at=datetime.utcnow() if done else None,
        )
        session.add(row)
        session.flush()
        return row.id


def _row(entry_id):
    from kurisuassistant.db.models import CalendarEntry
    from kurisuassistant.db.session import get_session

    with get_session() as session:
        row = session.get(CalendarEntry, entry_id)
        return {"delivered_at": row.delivered_at, "attempts": row.delivery_attempts}


async def test_a_due_reminder_is_delivered_once(user_id, delivered):
    now = datetime.utcnow()
    due = _entry(user_id, "Call Mom", at=now - timedelta(minutes=1))

    await reminders.scan_once()
    await reminders.scan_once()

    mine = [c for c in delivered if c["id"] == due]
    assert len(mine) == 1
    assert mine[0]["user_id"] == user_id
    assert mine[0]["title"] == "Call Mom"
    assert mine[0]["time_zone"] == "America/Los_Angeles"
    assert _row(due)["delivered_at"] is not None


async def test_what_is_not_due_is_left_alone(user_id, delivered):
    now = datetime.utcnow()
    future = _entry(user_id, "Later", at=now + timedelta(hours=1))
    done = _entry(user_id, "Already done", at=now - timedelta(minutes=5), done=True)
    event = _entry(user_id, "An event", at=now - timedelta(minutes=5), kind="event")

    await reminders.scan_once()

    ids = {c["id"] for c in delivered}
    assert not ids & {future, done, event}
    assert _row(future)["delivered_at"] is None


async def test_a_failed_delivery_is_tried_again_then_given_up(user_id, monkeypatch, caplog):
    attempts = []

    async def failing(entry):
        attempts.append(entry["id"])
        raise RuntimeError("no device reachable")

    monkeypatch.setattr(delivery, "deliver", failing)
    due = _entry(user_id, "Call Mom", at=datetime.utcnow() - timedelta(minutes=1))

    await reminders.scan_once()
    assert _row(due)["delivered_at"] is None, "a failure must not be recorded as delivered"
    assert _row(due)["attempts"] == 1

    for _ in range(reminders.MAX_DELIVERY_ATTEMPTS + 2):
        await reminders.scan_once()

    assert attempts.count(due) == reminders.MAX_DELIVERY_ATTEMPTS
    assert _row(due)["delivered_at"] is not None  # given up: stamped, left alone
    assert any("giving up" in r.getMessage() for r in caplog.records)


def test_deliver_hands_the_reminder_to_notifications(monkeypatch):
    """The contract with #353: one call, source "calendar", the reminder's id."""
    import asyncio
    import sys
    import types

    sent = []

    async def notify(user_id, **kwargs):
        sent.append((user_id, kwargs))

    fake = types.ModuleType("kurisuassistant.notifications")
    fake.notify = notify
    monkeypatch.setitem(sys.modules, "kurisuassistant.notifications", fake)

    asyncio.run(delivery.deliver({
        "id": 7, "user_id": 3, "title": "Call Mom",
        "starts_at": datetime(2026, 10, 17, 2, 0), "time_zone": "America/Los_Angeles",
    }))

    [(user, kwargs)] = sent
    assert user == 3
    assert kwargs["source"] == "calendar"
    assert kwargs["reminder_id"] == 7
    assert kwargs["title"] == "Call Mom"
    assert "19:00" in kwargs["body"]
