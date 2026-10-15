"""System tests: notifications pushed to phones through Firebase Cloud Messaging (#353).

A phone's app is not running to hold a socket, so the server pushes to it: each
phone registers its FCM token (``POST /notifications/devices``), and ``notify()``
and every read send FCM *data* messages through the HTTP v1 API — the app builds
the system notification itself, and cancels it when one is read anywhere.

With no service account configured (``FCM_SERVICE_ACCOUNT_FILE``) push is off and
everything else is unchanged. FCM itself is never reached here: the HTTP client
is an ``httpx.MockTransport`` that records each send and answers as FCM would.
"""

import json

import httpx
import pytest

pytestmark = pytest.mark.db


def register(account, token, platform="android"):
    resp = account.client.post(
        "/notifications/devices", json={"platform": platform, "fcm_token": token}, headers=account.headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def send(account, **kwargs):
    from kurisuassistant.notifications import notify

    kwargs.setdefault("source", "assistant")
    kwargs.setdefault("title", "A title")
    kwargs.setdefault("body", "A body")
    account.client.portal.call(lambda: notify(account.id, **kwargs))


def mark_read(account, notification_id):
    resp = account.client.post(f"/notifications/{notification_id}/read", headers=account.headers)
    assert resp.status_code == 200, resp.text


def devices_of(account):
    from kurisuassistant.db.models import NotificationDevice
    from kurisuassistant.db.session import get_session

    with get_session() as session:
        return sorted(d.fcm_token for d in session.query(NotificationDevice).filter_by(user_id=account.id))


class FakeFcm:
    """FCM's HTTP v1 endpoint: records every send, answers per token."""

    def __init__(self):
        self.sent = []
        self.answers = {}

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.sent.append({"url": str(request.url), "auth": request.headers.get("authorization"), "body": body})
        token = body["message"]["token"]
        status, error = self.answers.get(token, (200, None))
        if status == 200:
            return httpx.Response(200, json={"name": f"projects/kurisu-test/messages/{len(self.sent)}"})
        return httpx.Response(status, json={"error": {"status": error, "details": [{"errorCode": error}]}})

    def data(self):
        return [s["body"]["message"]["data"] for s in self.sent]


@pytest.fixture
def fcm(system_client):
    from kurisuassistant.notifications import push

    fake = FakeFcm()
    push.configure(
        project_id="kurisu-test",
        access_token=lambda: "test-access-token",
        transport=httpx.MockTransport(fake.handler),
    )
    yield fake
    push.configure(project_id=None)


class TestDevices:
    def test_a_phone_registers_its_token(self, account):
        register(account, "token-a")
        register(account, "token-a")  # refreshing it is the same device
        register(account, "token-b")
        assert devices_of(account) == ["token-a", "token-b"]

    def test_a_token_belongs_to_whoever_registered_it_last(self, account, system_client):
        from tests.conftest import Account, _create_activated_user

        _create_activated_user("push-other", "an-account-password")
        other = Account(system_client, "push-other", "an-account-password")
        register(account, "shared-phone")
        register(other, "shared-phone")  # signed in as someone else on the same phone
        assert devices_of(account) == []
        assert devices_of(other) == ["shared-phone"]

    def test_unregistering_removes_it(self, account):
        register(account, "token-a")
        resp = account.client.delete("/notifications/devices/token-a", headers=account.headers)
        assert resp.status_code == 200, resp.text
        assert devices_of(account) == []

    def test_another_accounts_token_cannot_be_removed(self, account, system_client):
        from tests.conftest import Account, _create_activated_user

        _create_activated_user("push-thief", "an-account-password")
        thief = Account(system_client, "push-thief", "an-account-password")
        register(account, "mine")
        resp = thief.client.delete("/notifications/devices/mine", headers=thief.headers)
        assert resp.status_code == 404
        assert devices_of(account) == ["mine"]

    def test_a_platform_and_a_token_are_required(self, account):
        resp = account.client.post("/notifications/devices", json={"platform": "android"}, headers=account.headers)
        assert resp.status_code == 422


class TestPush:
    def test_a_notification_is_pushed_to_every_phone_as_data(self, account, fcm):
        register(account, "phone-1")
        register(account, "phone-2")
        send(account, title="Laundry", body="The machine is done.", reminder_id=None)

        assert sorted(s["body"]["message"]["token"] for s in fcm.sent) == ["phone-1", "phone-2"]
        first = fcm.sent[0]
        assert first["url"] == "https://fcm.googleapis.com/v1/projects/kurisu-test/messages:send"
        assert first["auth"] == "Bearer test-access-token"
        message = first["body"]["message"]
        assert "notification" not in message, "data only: the app builds the system notification"
        assert message["android"]["priority"] == "high"
        data = message["data"]
        assert data["type"] == "notification"
        assert (data["sender"], data["title"], data["body"]) == ("Assistant", "Laundry", "The machine is done.")
        assert data["source"] == "assistant"
        assert data["conversation_id"] == "" and data["reminder_id"] == ""
        assert data["id"].isdigit()
        assert all(isinstance(v, str) for v in data.values()), "FCM data values are strings"

    def test_a_read_is_pushed_so_phones_take_it_down(self, account, fcm):
        register(account, "phone-1")
        send(account, title="One")
        send(account, title="Two")
        ids = [int(d["id"]) for d in fcm.data()]
        fcm.sent.clear()

        mark_read(account, ids[0])
        assert fcm.data() == [{"type": "notifications_read", "ids": str(ids[0])}]

        fcm.sent.clear()
        resp = account.client.post("/notifications/read-all", headers=account.headers)
        assert resp.status_code == 200
        assert fcm.data() == [{"type": "notifications_read", "ids": str(ids[1])}]

    def test_only_the_accounts_own_phones(self, account, system_client, fcm):
        from tests.conftest import Account, _create_activated_user

        _create_activated_user("push-bystander", "an-account-password")
        bystander = Account(system_client, "push-bystander", "an-account-password")
        register(bystander, "their-phone")
        register(account, "my-phone")
        send(account, title="Mine")
        assert [s["body"]["message"]["token"] for s in fcm.sent] == ["my-phone"]

    @pytest.mark.parametrize("status,error", [(404, "UNREGISTERED"), (400, "INVALID_ARGUMENT")])
    def test_a_token_fcm_no_longer_knows_is_dropped(self, account, fcm, status, error):
        register(account, "gone")
        register(account, "fine")
        fcm.answers["gone"] = (status, error)
        send(account, title="Hello")
        assert devices_of(account) == ["fine"]

    def test_an_fcm_outage_keeps_the_token_and_the_notification(self, account, fcm):
        register(account, "phone")
        fcm.answers["phone"] = (503, "UNAVAILABLE")
        send(account, title="Still stored")
        assert devices_of(account) == ["phone"]
        resp = account.client.get("/notifications", headers=account.headers)
        assert resp.json()["notifications"][0]["title"] == "Still stored"


class TestPushOff:
    def test_without_credentials_nothing_is_pushed_and_nothing_breaks(self, account, monkeypatch):
        from kurisuassistant.notifications import push

        push.configure(project_id=None)
        sent = []
        monkeypatch.setattr(httpx.AsyncClient, "post", lambda *a, **k: sent.append(a))
        register(account, "phone")
        send(account, title="Stored anyway")
        assert sent == []
        resp = account.client.get("/notifications", headers=account.headers)
        assert resp.json()["notifications"][0]["title"] == "Stored anyway"

    def test_it_says_so_once_at_startup(self, monkeypatch, caplog):
        from kurisuassistant.notifications import push

        monkeypatch.delenv("FCM_SERVICE_ACCOUNT_FILE", raising=False)
        push.configure(project_id=None)
        monkeypatch.setattr(push, "_said_off", False)  # as in a fresh process
        with caplog.at_level("INFO"):
            push.init_from_environment()
            push.init_from_environment()
        lines = [r.getMessage() for r in caplog.records if "FCM_SERVICE_ACCOUNT_FILE" in r.getMessage()]
        assert len(lines) == 1

    def test_a_service_account_file_turns_it_on(self, monkeypatch, tmp_path):
        from kurisuassistant.notifications import push

        key = tmp_path / "service-account.json"
        key.write_text(json.dumps({"type": "service_account", "project_id": "from-the-file"}))
        monkeypatch.setenv("FCM_SERVICE_ACCOUNT_FILE", str(key))
        monkeypatch.setattr(push, "_credentials_from_file", lambda path: object())
        push.configure(project_id=None)
        push.init_from_environment()
        assert push.enabled()
        assert push.project_id() == "from-the-file"
        push.configure(project_id=None)
