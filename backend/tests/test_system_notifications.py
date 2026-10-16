"""System tests: notifications reach every device of the account (#353).

The server keeps every notification and whether it has been read; the clients
only display them. The chat socket is last-one-wins — a second device displaces
the first — so it cannot carry something meant for the phone *and* the desktop.
Notifications have a socket of their own, ``/ws/notifications``, which any number
of devices hold at once and which never displaces the chat. On connect it sends
what is unread, so a device that was away catches up and drops what was read
meanwhile; then each new notification, and each read, as it happens. Reading one
on any device — directly, all at once, or by opening the conversation it points
to — reads it everywhere. ``notify()`` is the one way in: the ``notify_user`` tool
and calendar reminders both go through it.
"""

import pytest
from starlette.websockets import WebSocketDisconnect

from kurisuassistant.version import WIRE_PROTOCOL
from tests.mock_ollama import DEFAULT_MODEL, Reply, ToolCall

pytestmark = pytest.mark.db


def notifications_socket(account, **kwargs):
    return account.client.websocket_connect("/ws/notifications", headers=kwargs.pop("headers", account.headers), **kwargs)


def ready(ws):
    event = ws.receive_json()
    assert event["type"] == "notifications_ready", event
    return event


def send(account, **kwargs):
    """``notify()`` on the app's own event loop, as a tool or a reminder would call it."""
    from kurisuassistant.notifications import notify

    kwargs.setdefault("source", "assistant")
    kwargs.setdefault("title", "A title")
    kwargs.setdefault("body", "A body")
    account.client.portal.call(lambda: notify(account.id, **kwargs))


def chat_request(text, conversation_id=None):
    return {"type": "chat_request", "text": text, "model_name": DEFAULT_MODEL, "conversation_id": conversation_id}


def read_until(ws, *types, limit=300):
    out = []
    for _ in range(limit):
        event = ws.receive_json()
        out.append(event)
        if event["type"] in types:
            return out
    raise AssertionError(f"no {types} after {limit} events: {[e['type'] for e in out]}")


def set_mode(account, mode):
    resp = account.client.patch("/assistant", json={"permission_mode": mode}, headers=account.headers)
    assert resp.status_code == 200, resp.text


def use_persona(account, name):
    resp = account.client.post("/personas", json={"name": name, "system_prompt": ""}, headers=account.headers)
    assert resp.status_code in (200, 201), resp.text
    persona_id = resp.json()["id"]
    resp = account.client.patch("/assistant", json={"selected_persona_id": persona_id}, headers=account.headers)
    assert resp.status_code == 200, resp.text
    return persona_id


class TestDelivery:
    def test_a_connected_device_receives_it(self, account):
        with notifications_socket(account) as ws:
            ready(ws)
            send(account, title="Flight prices to Hanoi", body="A December fare dropped.", conversation_id=None)
            event = ws.receive_json()

        assert event["type"] == "notification"
        assert event["source"] == "assistant"
        assert event["title"] == "Flight prices to Hanoi"
        assert event["body"] == "A December fare dropped."
        assert isinstance(event["id"], int)
        assert event["created_at"]

    def test_every_device_of_the_account_receives_it(self, account):
        """The phone and the desktop at once: neither displaces the other."""
        with notifications_socket(account) as phone, notifications_socket(account) as desktop:
            ready(phone)
            ready(desktop)
            send(account, title="Both")
            assert phone.receive_json()["title"] == "Both"
            assert desktop.receive_json()["title"] == "Both"

    def test_it_does_not_displace_the_chat(self, account, mock_ollama):
        """The chat socket closes any other chat socket of the account; a
        notifications socket opened beside it must not be one of them, nor be
        closed by a chat socket opened after it."""
        mock_ollama.state.script(Reply(content="Still here."))
        with account.socket() as chat:
            assert chat.receive_json()["type"] == "connected"
            with notifications_socket(account) as ws:
                ready(ws)
                with account.socket() as second_chat:
                    assert second_chat.receive_json()["type"] == "connected"
                    second_chat.send_json(chat_request("are you there"))
                    assert read_until(second_chat, "done", "error")[-1]["type"] == "done"
                send(account, title="Still listening")
                assert ws.receive_json()["title"] == "Still listening"

    def test_another_account_does_not_receive_it(self, account, system_client, mock_ollama):
        from tests.conftest import Account, _create_activated_user

        _create_activated_user("notif-other", "an-account-password")
        other = Account(system_client, "notif-other", "an-account-password")
        with notifications_socket(other) as theirs, notifications_socket(account) as mine:
            ready(theirs)
            ready(mine)
            send(account, title="Mine")
            assert mine.receive_json()["title"] == "Mine"
            send(other, title="Theirs")
            assert theirs.receive_json()["title"] == "Theirs", "the first one never reached them"


class TestSender:
    def test_the_assistant_with_no_persona_is_the_assistant(self, account):
        with notifications_socket(account) as ws:
            ready(ws)
            send(account, source="assistant")
            assert ws.receive_json()["sender"] == "Assistant"

    def test_the_assistant_is_shown_under_the_persona_in_use(self, account):
        use_persona(account, "Kurisu")
        with notifications_socket(account) as ws:
            ready(ws)
            send(account, source="assistant")
            assert ws.receive_json()["sender"] == "Kurisu"

    def test_a_reminder_is_from_the_calendar(self, account):
        use_persona(account, "Kurisu")
        with notifications_socket(account) as ws:
            ready(ws)
            send(account, source="calendar", title="Call Mom", body="Due at 19:00.", reminder_id=42)
            event = ws.receive_json()
        assert event["sender"] == "Calendar"
        assert event["source"] == "calendar"
        assert event["reminder_id"] == 42
        assert event["conversation_id"] is None


class TestCatchingUp:
    def test_ready_carries_what_is_unread_oldest_first(self, account):
        send(account, title="First")
        send(account, title="Second")
        with notifications_socket(account) as ws:
            unread = ready(ws)["unread"]
        assert [n["title"] for n in unread] == ["First", "Second"]
        assert all(n["type"] == "notification" and n["read_at"] is None for n in unread)

    def test_what_was_read_meanwhile_is_not_in_it(self, account):
        send(account, title="Read on the phone")
        send(account, title="Still unread")
        first = list_notifications(account)["notifications"][-1]
        mark_read(account, first["id"])
        with notifications_socket(account) as ws:
            assert [n["title"] for n in ready(ws)["unread"]] == ["Still unread"]

    def test_a_new_account_has_nothing_unread(self, account):
        with notifications_socket(account) as ws:
            assert ready(ws)["unread"] == []


def list_notifications(account, **params):
    resp = account.client.get("/notifications", params=params, headers=account.headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def mark_read(account, notification_id):
    resp = account.client.post(f"/notifications/{notification_id}/read", headers=account.headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


class TestStoredOnTheServer:
    def test_every_notification_is_kept_with_its_read_state(self, account):
        send(account, title="One", body="b1")
        send(account, source="calendar", title="Two", reminder_id=9)
        body = list_notifications(account)
        assert body["unread_count"] == 2
        newest, oldest = body["notifications"]
        assert (newest["title"], newest["source"], newest["reminder_id"]) == ("Two", "calendar", 9)
        assert (oldest["title"], oldest["body"]) == ("One", "b1")
        assert newest["read_at"] is None and oldest["read_at"] is None

    def test_unread_come_first_then_newest_first(self, account):
        for title in ("a", "b", "c"):
            send(account, title=title)
        a = next(n for n in list_notifications(account)["notifications"] if n["title"] == "a")
        c = next(n for n in list_notifications(account)["notifications"] if n["title"] == "c")
        mark_read(account, c["id"])
        assert [n["title"] for n in list_notifications(account)["notifications"]] == ["b", "a", "c"]
        assert a["read_at"] is None

    def test_pages_and_the_unread_filter(self, account):
        for i in range(5):
            send(account, title=f"n{i}")
        newest = list_notifications(account)["notifications"][0]
        mark_read(account, newest["id"])
        assert [n["title"] for n in list_notifications(account, limit=2)["notifications"]] == ["n3", "n2"]
        assert [n["title"] for n in list_notifications(account, limit=2, offset=2)["notifications"]] == ["n1", "n0"]
        unread = list_notifications(account, unread=True)
        assert [n["title"] for n in unread["notifications"]] == ["n3", "n2", "n1", "n0"]
        assert unread["unread_count"] == 4

    def test_another_accounts_notification_cannot_be_read_or_seen(self, account, system_client):
        from tests.conftest import Account, _create_activated_user

        _create_activated_user("notif-reader", "an-account-password")
        other = Account(system_client, "notif-reader", "an-account-password")
        send(account, title="Mine")
        mine = list_notifications(account)["notifications"][0]
        assert list_notifications(other)["notifications"] == []
        resp = other.client.post(f"/notifications/{mine['id']}/read", headers=other.headers)
        assert resp.status_code == 404
        assert list_notifications(account)["notifications"][0]["read_at"] is None


class TestReadingIsEverywhere:
    def test_reading_one_tells_every_device(self, account):
        send(account, title="Laundry")
        notification = list_notifications(account)["notifications"][0]
        with notifications_socket(account) as phone, notifications_socket(account) as desktop:
            ready(phone)
            ready(desktop)
            read = mark_read(account, notification["id"])
            assert read["read_at"]
            for ws in (phone, desktop):
                event = ws.receive_json()
                assert event["type"] == "notifications_read"
                assert event["ids"] == [notification["id"]]
                assert event["read_at"] == read["read_at"]
        assert list_notifications(account)["unread_count"] == 0

    def test_reading_one_twice_tells_nobody_the_second_time(self, account):
        send(account, title="Once")
        notification_id = list_notifications(account)["notifications"][0]["id"]
        first = mark_read(account, notification_id)
        with notifications_socket(account) as ws:
            ready(ws)
            assert mark_read(account, notification_id)["read_at"] == first["read_at"]
            send(account, title="Next")
            assert ws.receive_json()["title"] == "Next", "no second notifications_read before it"

    def test_reading_all_tells_every_device_which(self, account):
        send(account, title="x")
        send(account, title="y")
        ids = sorted(n["id"] for n in list_notifications(account)["notifications"])
        with notifications_socket(account) as ws:
            ready(ws)
            resp = account.client.post("/notifications/read-all", headers=account.headers)
            assert resp.status_code == 200, resp.text
            assert sorted(resp.json()["ids"]) == ids
            event = ws.receive_json()
        assert event["type"] == "notifications_read"
        assert sorted(event["ids"]) == ids
        assert list_notifications(account)["unread_count"] == 0

    def test_opening_what_it_points_to_reads_it(self, account, mock_ollama):
        mock_ollama.state.script(Reply(content="Hi."))
        with account.socket() as chat:
            chat.receive_json()
            chat.send_json(chat_request("hello"))
            events = read_until(chat, "done", "error")
        conversation_id = next(e["conversation_id"] for e in events if e.get("conversation_id"))
        send(account, title="About the chat", conversation_id=conversation_id)
        send(account, source="calendar", title="Reminder", reminder_id=5)
        send(account, title="Unrelated")

        with notifications_socket(account) as ws:
            ready(ws)
            resp = account.client.post(
                "/notifications/read-for", json={"conversation_id": conversation_id}, headers=account.headers,
            )
            assert resp.status_code == 200, resp.text
            assert ws.receive_json()["type"] == "notifications_read"
            resp = account.client.post("/notifications/read-for", json={"reminder_id": 5}, headers=account.headers)
            assert resp.status_code == 200, resp.text
            assert ws.receive_json()["type"] == "notifications_read"

        assert [n["title"] for n in list_notifications(account, unread=True)["notifications"]] == ["Unrelated"]

    def test_read_for_needs_something_to_point_at(self, account):
        resp = account.client.post("/notifications/read-for", json={}, headers=account.headers)
        assert resp.status_code == 422

    def test_a_new_notification_says_it_is_unread(self, account):
        with notifications_socket(account) as ws:
            ready(ws)
            send(account, title="Fresh")
            assert ws.receive_json()["read_at"] is None


class TestHandshake:
    def _close_of(self, client, path="/ws/notifications", **kwargs):
        with pytest.raises(WebSocketDisconnect) as excinfo:
            with client.websocket_connect(path, **kwargs) as ws:
                ws.receive_json()
        return excinfo.value

    def test_no_credentials_close_4001(self, system_client):
        assert self._close_of(system_client).code == 4001

    def test_a_mismatched_wire_protocol_closes_4426(self, account):
        closed = self._close_of(
            account.client,
            headers={"Authorization": f"Bearer {account.token}", "X-Wire-Protocol": str(WIRE_PROTOCOL + 1)},
        )
        assert closed.code == 4426

    def test_the_browser_subprotocol_carrier_works(self, account):
        with account.client.websocket_connect(
            "/ws/notifications",
            subprotocols=["kurisu.auth.bearer", account.token, f"kurisu.wire.{WIRE_PROTOCOL}"],
        ) as ws:
            ready(ws)


class TestNotifyNeverRaises:
    def test_a_delivery_failure_is_logged_not_raised(self, account, monkeypatch, caplog):
        from kurisuassistant.notifications import service

        async def broken(*args, **kwargs):
            raise RuntimeError("the database went away")

        monkeypatch.setattr(service, "_store", broken)
        send(account, title="Lost")  # must not raise
        assert any("notification" in r.getMessage().lower() for r in caplog.records if r.levelname == "ERROR")


class TestTheTool:
    def test_the_assistant_notifies_the_user_from_a_conversation(self, account, mock_ollama):
        mock_ollama.state.script(
            Reply(tool_calls=[ToolCall("notify_user", {"title": "Laundry", "body": "The machine is done."})]),
            Reply(content="I let you know."),
        )
        with notifications_socket(account) as phone:
            ready(phone)
            with account.socket() as chat:
                chat.receive_json()
                chat.send_json(chat_request("tell me when the laundry is done"))
                events = read_until(chat, "done", "error")
            assert events[-1]["type"] == "done"
            event = phone.receive_json()

        conversation_id = next(e["conversation_id"] for e in events if e.get("conversation_id"))
        assert event["title"] == "Laundry"
        assert event["body"] == "The machine is done."
        assert event["source"] == "assistant"
        assert event["conversation_id"] == conversation_id

    def test_it_needs_no_approval_even_in_always_ask(self, account, mock_ollama):
        """Allowed by default (#353): it never waits, in any permission mode —
        a task with nobody attached can still notify."""
        mock_ollama.state.script(
            Reply(tool_calls=[ToolCall("notify_user", {"title": "Done", "body": "Finished."})]),
            Reply(content="Told you."),
        )
        with notifications_socket(account) as phone:
            ready(phone)
            with account.socket() as chat:
                chat.receive_json()
                chat.send_json(chat_request("let me know"))
                events = read_until(chat, "done", "error")
            assert "tool_approval_request" not in [e["type"] for e in events]
            assert phone.receive_json()["title"] == "Done"

    def test_it_is_listed_as_only_looking(self, account):
        resp = account.client.get("/tools", headers=account.headers)
        assert resp.status_code == 200, resp.text
        flags = {t["function"]["name"]: t.get("read_only") for t in resp.json()["server_tools"]}
        assert flags["notify_user"] is True
        assert flags["drive_write"] is False

    def test_it_is_offered_to_the_model(self, account, mock_ollama):
        mock_ollama.state.script(Reply(content="Hi."))
        with account.socket() as chat:
            chat.receive_json()
            chat.send_json(chat_request("hello"))
            read_until(chat, "done", "error")
        request = mock_ollama.state.requests_to("/api/chat")[0]
        assert "notify_user" in {t["function"]["name"] for t in request.get("tools") or []}

    def test_read_only_still_sends_it(self, account, mock_ollama):
        set_mode(account, "read_only")
        mock_ollama.state.script(
            Reply(tool_calls=[ToolCall("notify_user", {"title": "Still", "body": "Here."})]),
            Reply(content="Sent."),
        )
        with account.socket() as chat:
            chat.receive_json()
            chat.send_json(chat_request("notify me"))
            read_until(chat, "done", "error")
        assert [n["title"] for n in list_notifications(account)["notifications"]] == ["Still"]
