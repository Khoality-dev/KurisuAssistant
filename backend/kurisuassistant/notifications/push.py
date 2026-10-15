"""Push to phones through Firebase Cloud Messaging (#353).

A phone's app is not running to hold ``/ws/notifications``, so the server
pushes to it: every phone of the account that registered an FCM token
(``notification_devices``) is sent a *data* message — high priority, no
``notification`` block — for each new notification and for each read. The app
builds the system notification itself, so it looks the same however it
arrived, and cancels it when one is read on any device.

FCM's HTTP v1 API over plain ``httpx``, with an OAuth token minted from a
service account by ``google-auth`` — not the Firebase Admin SDK, which would
bring a second HTTP stack and gRPC for one call. The service account JSON is a
file the operator mounts and names in ``FCM_SERVICE_ACCOUNT_FILE``; the
project id is read from it. With none, push is off, said once at startup, and
everything else — the socket, the REST, the desktop — is unchanged.

A token FCM reports as unregistered or invalid is dropped. Any other failure
(FCM down, a timeout) is logged and the token kept: the notification is stored
either way, and the phone catches up when the app next opens.
"""

import asyncio
import json
import logging
import os
from datetime import datetime
from typing import Callable, Iterable, Optional

import httpx

from kurisuassistant.db.service import get_db_service

logger = logging.getLogger(__name__)

SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
FCM_SEND_URL = "https://fcm.googleapis.com/v1/projects/{project_id}/messages:send"
SEND_TIMEOUT_SECONDS = 10.0

# Error codes after which a token will never work again.
_DEAD_TOKEN_CODES = {"UNREGISTERED", "INVALID_ARGUMENT"}

_project_id: Optional[str] = None
_access_token: Optional[Callable[[], str]] = None
_transport: Optional[httpx.AsyncBaseTransport] = None
_said_off = False


def configure(
    project_id: Optional[str],
    access_token: Optional[Callable[[], str]] = None,
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> None:
    """Turn push on for ``project_id`` (off when None). Tests pass a fake token and transport."""
    global _project_id, _access_token, _transport
    _project_id = project_id
    _access_token = access_token if project_id else None
    _transport = transport


def enabled() -> bool:
    return _project_id is not None and _access_token is not None


def project_id() -> Optional[str]:
    return _project_id


def _credentials_from_file(path: str):
    from google.oauth2 import service_account

    return service_account.Credentials.from_service_account_file(path, scopes=[SCOPE])


def _token_from(credentials) -> str:
    """A current OAuth token, refreshed when it has expired. Blocking: run off the loop."""
    if not credentials.valid:
        import google.auth.transport.requests

        credentials.refresh(google.auth.transport.requests.Request())
    return credentials.token


def init_from_environment() -> None:
    """At startup: push is on when ``FCM_SERVICE_ACCOUNT_FILE`` names a service account."""
    global _said_off
    path = os.getenv("FCM_SERVICE_ACCOUNT_FILE", "").strip()
    if not path:
        if not _said_off:
            logger.info("Push to phones is off: FCM_SERVICE_ACCOUNT_FILE is not set")
            _said_off = True
        return
    try:
        with open(path) as f:
            project = json.load(f)["project_id"]
        credentials = _credentials_from_file(path)
    except Exception:
        logger.error("Push to phones is off: could not read the service account at %s", path, exc_info=True)
        return
    configure(project, access_token=lambda: _token_from(credentials))
    logger.info("Push to phones is on (Firebase project %s)", project)


def _as_data(event: dict) -> dict:
    """FCM data values are strings; a missing value is an empty one."""
    return {key: "" if value is None else str(value) for key, value in event.items()}


async def send_notification(user_id: int, event: dict) -> None:
    await _send(user_id, _as_data(event))


async def send_read(user_id: int, ids: Iterable[int]) -> None:
    await _send(user_id, {"type": "notifications_read", "ids": ",".join(str(i) for i in ids)})


async def _send(user_id: int, data: dict) -> None:
    if not enabled():
        return
    tokens = await get_db_service().execute(lambda session: _tokens_of(session, user_id))
    if not tokens:
        return
    access_token = await asyncio.to_thread(_access_token)
    url = FCM_SEND_URL.format(project_id=_project_id)
    dead = []
    async with httpx.AsyncClient(transport=_transport, timeout=SEND_TIMEOUT_SECONDS) as client:
        for token in tokens:
            message = {"message": {"token": token, "data": data, "android": {"priority": "high"}}}
            try:
                response = await client.post(url, json=message, headers={"Authorization": f"Bearer {access_token}"})
            except httpx.HTTPError as e:
                logger.warning("Could not reach FCM for user %s: %s", user_id, e)
                continue
            if response.status_code == 200:
                continue
            code = _error_code(response)
            if code in _DEAD_TOKEN_CODES or response.status_code == 404:
                dead.append(token)
            else:
                logger.warning("FCM refused a push for user %s: %s %s", user_id, response.status_code, code)
    if dead:
        await get_db_service().execute(lambda session: _drop(session, dead))
        logger.info("Dropped %d phone token(s) FCM no longer knows", len(dead))


def _error_code(response: httpx.Response) -> Optional[str]:
    try:
        error = response.json().get("error", {})
    except ValueError:
        return None
    for detail in error.get("details") or []:
        if isinstance(detail, dict) and detail.get("errorCode"):
            return detail["errorCode"]
    return error.get("status")


def _tokens_of(session, user_id: int) -> list:
    from kurisuassistant.db.models import NotificationDevice

    return [row.fcm_token for row in session.query(NotificationDevice).filter_by(user_id=user_id).all()]


def _drop(session, tokens: list) -> None:
    from kurisuassistant.db.models import NotificationDevice

    session.query(NotificationDevice).filter(NotificationDevice.fcm_token.in_(tokens)).delete(synchronize_session=False)


def register(user_id: int, platform: str, token: str) -> None:
    """DB operation: the token is this account's now — one installed app, one owner."""
    from kurisuassistant.db.models import NotificationDevice

    def _write(session):
        now = datetime.utcnow()
        row = session.query(NotificationDevice).filter_by(fcm_token=token).one_or_none()
        if row is None:
            session.add(NotificationDevice(user_id=user_id, platform=platform, fcm_token=token, created_at=now, last_seen_at=now))
        else:
            row.user_id, row.platform, row.last_seen_at = user_id, platform, now

    return _write


def unregister(user_id: int, token: str):
    """DB operation: remove the account's own token; False when it is not theirs."""
    from kurisuassistant.db.models import NotificationDevice

    def _write(session):
        return session.query(NotificationDevice).filter_by(user_id=user_id, fcm_token=token).delete() > 0

    return _write
