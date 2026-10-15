"""The account's time zone (#352): one IANA name per account, read in one place.

Schedules are wall-clock times, and the server cannot see a clock on the wall:
the clients fill the account's zone from the device the first time it is empty,
and the user can change it. Everything that turns "07:30" into a moment asks
``core.timezone.user_timezone`` — tasks now, the calendar later.
"""

from zoneinfo import ZoneInfo

import pytest

from kurisuassistant.core.timezone import parse_timezone, user_timezone


class _User:
    def __init__(self, timezone):
        self.timezone = timezone


class TestHelpers:
    def test_the_accounts_zone(self):
        assert user_timezone(_User("Europe/Paris")) == ZoneInfo("Europe/Paris")

    def test_utc_when_unset_or_unreadable(self):
        assert user_timezone(_User(None)) == ZoneInfo("UTC")
        assert user_timezone(_User("Mars/Olympus")) == ZoneInfo("UTC")
        assert user_timezone(None) == ZoneInfo("UTC")

    def test_parse_accepts_an_iana_name_and_refuses_anything_else(self):
        assert parse_timezone(" America/Los_Angeles ") == "America/Los_Angeles"
        with pytest.raises(ValueError, match="Mars/Olympus"):
            parse_timezone("Mars/Olympus")
        with pytest.raises(ValueError):
            parse_timezone("+02:00")


@pytest.mark.db
class TestProfile:
    def test_unset_until_a_client_fills_it(self, account):
        assert account.client.get("/users/me", headers=account.headers).json()["timezone"] is None

    def test_set_read_back_and_clear(self, account):
        resp = account.client.patch("/users/me", json={"timezone": "Europe/Paris"}, headers=account.headers)
        assert resp.status_code == 200, resp.text
        assert account.client.get("/users/me", headers=account.headers).json()["timezone"] == "Europe/Paris"

        account.client.patch("/users/me", json={"timezone": ""}, headers=account.headers)
        assert account.client.get("/users/me", headers=account.headers).json()["timezone"] is None

    def test_a_zone_that_is_not_iana_is_a_422(self, account):
        resp = account.client.patch("/users/me", json={"timezone": "Mars/Olympus"}, headers=account.headers)
        assert resp.status_code == 422
        assert "Mars/Olympus" in resp.json()["detail"]
        assert account.client.get("/users/me", headers=account.headers).json()["timezone"] is None


class TestCurrentTimeLine:
    """The prompt's clock is the user's: their date, weekday and zone (#352)."""

    def test_local_time_with_weekday_and_zone(self):
        from datetime import datetime

        from kurisuassistant.core.timezone import local_time_label

        # 16:42 UTC on Friday 16 October 2026 is 18:42 in Paris (summer time).
        now = datetime(2026, 10, 16, 16, 42)
        assert local_time_label(ZoneInfo("Europe/Paris"), now) == "Friday 16 October 2026, 18:42 (Europe/Paris)"
        assert local_time_label(ZoneInfo("UTC"), now) == "Friday 16 October 2026, 16:42 (UTC)"
        # Across midnight the day is the user's, not the server's.
        assert local_time_label(ZoneInfo("Asia/Tokyo"), datetime(2026, 10, 16, 20, 0)).startswith("Saturday 17 October 2026, 05:00")


@pytest.mark.db
class TestThePromptsClock:
    def _system(self, mock_ollama):
        [request] = mock_ollama.state.requests_to("/api/chat")
        return "\n".join(m["content"] for m in request["messages"] if m["role"] == "system")

    def _chat(self, account):
        from tests.mock_ollama import DEFAULT_MODEL

        account.client.patch("/assistant", json={"model_name": DEFAULT_MODEL}, headers=account.headers)
        with account.socket() as ws:
            assert ws.receive_json()["type"] == "connected"
            ws.send_json({"type": "chat_request", "text": "hi", "model_name": "", "conversation_id": None})
            for _ in range(100):
                if ws.receive_json()["type"] in ("done", "error"):
                    break

    def test_a_chat_tells_the_model_the_users_local_time(self, account, mock_ollama):
        account.client.patch("/users/me", json={"timezone": "Europe/Paris"}, headers=account.headers)
        self._chat(account)
        line = next(l for l in self._system(mock_ollama).splitlines() if l.startswith("Current time:"))
        assert line.endswith("(Europe/Paris)")
        weekday = line.split()[2]
        assert weekday in ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")

    def test_utc_when_the_account_has_no_zone(self, account, mock_ollama):
        self._chat(account)
        line = next(l for l in self._system(mock_ollama).splitlines() if l.startswith("Current time:"))
        assert line.endswith("(UTC)")
