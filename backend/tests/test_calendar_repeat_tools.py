"""The assistant sets, changes and stops a reminder's repeat (#355).

"Remind me to take my pills every morning at 8" is ``calendar_create`` with a
repeat; "only on weekdays from now on" and "stop reminding me" are
``calendar_repeat``. Run the way ``BaseAgent.execute_tool`` runs them, with the
account pinned to Los Angeles. Needs Postgres.
"""

import json
import uuid

import pytest

from kurisuassistant.tools.calendar import CalendarCreateTool, CalendarListTool, CalendarRepeatTool

pytestmark = pytest.mark.db

LA = "America/Los_Angeles"


@pytest.fixture()
def owner(system_client, monkeypatch):
    from zoneinfo import ZoneInfo

    from kurisuassistant.calendar import zone
    from kurisuassistant.core.accounts import provision_user
    from kurisuassistant.core.security import hash_password
    from kurisuassistant.db.repositories import UserRepository
    from kurisuassistant.db.session import get_session

    with get_session() as session:
        user = UserRepository(session).create_user(f"cal-rtool-{uuid.uuid4().hex[:8]}", hash_password("x"))
        provision_user(session, user)
        user.is_active = True
        session.flush()
        made = user.id
    monkeypatch.setattr(zone, "zone_for", lambda user: ZoneInfo(LA))
    return made


async def _create(user_id, **args):
    return json.loads(await CalendarCreateTool().execute({"user_id": user_id, **args}))


async def _repeat(user_id, **args):
    return json.loads(await CalendarRepeatTool().execute({"user_id": user_id, **args}))


class TestCreate:
    def test_the_schema_offers_the_three_repeats(self):
        params = CalendarCreateTool().get_schema()["function"]["parameters"]["properties"]
        assert params["repeat"]["enum"] == ["daily", "weekdays", "weekly"]
        assert params["repeat_days"]["items"]["enum"] == ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

    async def test_a_reminder_every_morning(self, owner):
        result = await _create(owner, kind="reminder", title="Take the pills", start="2026-10-16T08:00", repeat="daily")
        entry = result["entry"]
        assert entry["repeat"] == "daily"
        assert entry["repeat_from"] == "2026-10-16T15:00:00Z"
        assert "every day at 08:00" in result["summary"]

    async def test_every_week_on_chosen_days(self, owner):
        result = await _create(
            owner, kind="reminder", title="Bins out", start="2026-10-19T19:00", repeat="weekly", repeat_days=["thu", "mon"],
        )
        assert result["entry"]["repeat_days"] == ["mon", "thu"]
        assert "every Monday and Thursday at 19:00" in result["summary"]

    async def test_an_event_does_not_repeat(self, owner):
        out = await _create(owner, kind="event", title="Standup", start="2026-10-19T09:00", repeat="daily")
        assert "error" in out and out["error"].endswith(".")


class TestChange:
    async def test_the_repeat_changes(self, owner):
        created = await _create(owner, kind="reminder", title="Take the pills", start="2026-10-16T08:00", repeat="daily")
        changed = await _repeat(owner, id=created["entry"]["id"], repeat="weekdays")
        assert changed["entry"]["repeat"] == "weekdays"
        assert "every weekday at 08:00" in changed["summary"]

    async def test_stopping_it(self, owner):
        created = await _create(owner, kind="reminder", title="Take the pills", start="2026-10-16T08:00", repeat="daily")
        stopped = await _repeat(owner, id=created["entry"]["id"], repeat="none")
        assert stopped["entry"]["repeat"] is None
        assert "no longer repeats" in stopped["summary"]

    async def test_a_reminder_that_did_not_repeat_starts_to(self, owner):
        created = await _create(owner, kind="reminder", title="Water the plants", start="2026-10-16T08:00")
        changed = await _repeat(owner, id=created["entry"]["id"], repeat="weekly", repeat_days=["fri"])
        assert changed["entry"]["repeat"] == "weekly"
        assert "every Friday at 08:00" in changed["summary"]

    async def test_refusals_are_sentences(self, owner):
        created = await _create(owner, kind="reminder", title="Take the pills", start="2026-10-16T08:00")
        entry_id = created["entry"]["id"]
        for args in ({"id": entry_id, "repeat": "weekly"}, {"id": entry_id, "repeat": "hourly"}, {"id": 0, "repeat": "daily"}):
            out = await _repeat(owner, **args)
            assert out["error"].endswith("."), args

    def test_the_approval_sentence_says_what_changes(self):
        assert "every weekday" in CalendarRepeatTool().describe_call({"id": 7, "repeat": "weekdays"})
        assert "stop" in CalendarRepeatTool().describe_call({"id": 7, "repeat": "none"}).lower()
        assert CalendarRepeatTool().describe_call({})


class TestList:
    async def test_a_repeating_reminder_is_listed_once_with_its_repeat(self, owner):
        await _create(owner, kind="reminder", title="Take the pills", start="2026-10-16T08:00", repeat="daily")
        out = await CalendarListTool().execute({"user_id": owner, "from": "2026-10-16", "to": "2026-10-22"})
        lines = [line for line in out.splitlines() if "Take the pills" in line]
        assert len(lines) == 1
        assert "every day at 08:00" in lines[0]
        assert "next Fri 16 Oct 2026, 08:00" in lines[0]
