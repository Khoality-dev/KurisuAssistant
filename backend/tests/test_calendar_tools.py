"""The assistant's calendar tools (#282): calendar_create, calendar_list,
calendar_move, calendar_repeat (#355), calendar_delete.

Run directly, the way ``BaseAgent.execute_tool`` runs them — ``user_id``
injected into the arguments, never in the schema. The model writes wall-clock
time; the tool reads it in the account's zone, so "remind me at 7 on Friday"
lands on the right instant. Create and move answer in JSON with the entry, which
is what the chat's calendar card is drawn from.

Needs Postgres (``POSTGRES_HOST``/``POSTGRES_PORT``; CI provides one).
"""

import json
import uuid

import pytest

from kurisuassistant.tools import tool_registry
from kurisuassistant.tools.calendar import (
    CalendarCreateTool,
    CalendarDeleteTool,
    CalendarListTool,
    CalendarMoveTool,
)

pytestmark = pytest.mark.db

LA = "America/Los_Angeles"


@pytest.fixture()
def accounts(system_client, monkeypatch):
    """Two accounts: the first in Los Angeles, the second with no zone (UTC).

    The zone is the account setting #352 brings; until then the calendar asks
    ``calendar/zone.zone_for``, which is what is pinned here."""
    from kurisuassistant.core.accounts import provision_user
    from kurisuassistant.core.security import hash_password
    from kurisuassistant.db.repositories import UserRepository
    from kurisuassistant.db.session import get_session

    from zoneinfo import ZoneInfo

    from kurisuassistant.calendar import zone

    ids = []
    for _ in range(2):
        with get_session() as session:
            user = UserRepository(session).create_user(f"cal-tool-{uuid.uuid4().hex[:8]}", hash_password("x"))
            provision_user(session, user)
            user.is_active = True
            session.flush()
            ids.append(user.id)
    monkeypatch.setattr(
        zone, "zone_for", lambda user: ZoneInfo(LA) if user is not None and user.id == ids[0] else zone.UTC,
    )
    return ids


async def _create(user_id, **args):
    return json.loads(await CalendarCreateTool().execute({"user_id": user_id, **args}))


class TestRegistration:
    def test_all_five_are_registered_and_only_listing_looks(self):
        for name in ("calendar_create", "calendar_list", "calendar_move", "calendar_repeat", "calendar_delete"):
            tool = tool_registry.get(name)
            assert tool is not None, name
            assert tool.read_only is (name == "calendar_list"), name
            assert "user_id" not in json.dumps(tool.get_schema())

    def test_the_approval_sentence_names_the_entry(self):
        sentence = CalendarCreateTool().describe_call(
            {"kind": "reminder", "title": "Call Mom", "start": "2026-10-16T19:00"}
        )
        assert "Call Mom" in sentence and "2026-10-16 19:00" in sentence
        # A model's arguments can be anything; describing them must not throw.
        assert CalendarMoveTool().describe_call({"id": None, "start": 5})
        assert CalendarDeleteTool().describe_call({})


class TestCreate:
    async def test_a_reminder_is_read_in_the_accounts_zone(self, accounts):
        owner, _ = accounts
        result = await _create(owner, kind="reminder", title="Call Mom", start="2026-10-16T19:00")
        entry = result["entry"]
        assert entry["kind"] == "reminder"
        assert entry["starts_at"] == "2026-10-17T02:00:00Z"
        assert result["time_zone"] == LA
        assert "Fri 16 Oct 2026, 19:00" in result["summary"]

    async def test_no_zone_means_utc(self, accounts):
        _, utc_user = accounts
        result = await _create(utc_user, kind="reminder", title="Stand up", start="2026-10-16T19:00")
        assert result["entry"]["starts_at"] == "2026-10-16T19:00:00Z"
        assert result["time_zone"] == "UTC"

    async def test_a_date_alone_makes_an_all_day_event(self, accounts):
        owner, _ = accounts
        result = await _create(owner, kind="event", title="Linh's birthday", start="2026-10-18")
        assert result["entry"]["all_day"] is True
        assert result["entry"]["start_date"] == "2026-10-18"

    async def test_a_reminder_needs_a_time(self, accounts):
        owner, _ = accounts
        out = await CalendarCreateTool().execute(
            {"user_id": owner, "kind": "reminder", "title": "Someday", "start": "2026-10-18"}
        )
        assert "time" in out.lower()
        assert "error" in json.loads(out)

    async def test_nonsense_is_a_sentence_not_a_traceback(self, accounts):
        owner, _ = accounts
        out = await CalendarCreateTool().execute({"user_id": owner, "kind": "event", "title": "x", "start": "Friday"})
        assert "error" in json.loads(out)

    async def test_no_user_is_refused(self):
        out = await CalendarCreateTool().execute({"kind": "event", "title": "x", "start": "2026-10-18"})
        assert "error" in json.loads(out)


class TestListMoveDelete:
    async def test_list_shows_the_window_in_local_time(self, accounts):
        owner, _ = accounts
        await _create(owner, kind="reminder", title="Call Mom", start="2026-10-16T19:00")
        await _create(owner, kind="event", title="Way later", start="2027-03-01T10:00")
        out = await CalendarListTool().execute({"user_id": owner, "from": "2026-10-12", "to": "2026-10-19"})
        assert "Call Mom" in out and "Fri 16 Oct 2026, 19:00" in out
        assert "Way later" not in out

    async def test_move_and_delete_by_id(self, accounts):
        owner, _ = accounts
        created = await _create(owner, kind="reminder", title="Call Mom", start="2026-10-16T19:00")
        entry_id = created["entry"]["id"]

        moved = json.loads(await CalendarMoveTool().execute({"user_id": owner, "id": entry_id, "start": "2026-10-17T10:00"}))
        assert moved["entry"]["starts_at"] == "2026-10-17T17:00:00Z"

        deleted = json.loads(await CalendarDeleteTool().execute({"user_id": owner, "id": entry_id}))
        assert deleted["deleted"]["id"] == entry_id
        out = await CalendarListTool().execute({"user_id": owner, "from": "2026-10-12", "to": "2026-10-19"})
        assert "Call Mom" not in out

    async def test_another_accounts_entry_is_not_found(self, accounts):
        owner, stranger = accounts
        created = await _create(owner, kind="reminder", title="Call Mom", start="2026-10-16T19:00")
        entry_id = created["entry"]["id"]
        for tool, extra in ((CalendarMoveTool(), {"start": "2026-10-17T10:00"}), (CalendarDeleteTool(), {})):
            out = json.loads(await tool.execute({"user_id": stranger, "id": entry_id, **extra}))
            assert "error" in out
        out = await CalendarListTool().execute({"user_id": owner, "from": "2026-10-12", "to": "2026-10-19"})
        assert "Call Mom" in out
