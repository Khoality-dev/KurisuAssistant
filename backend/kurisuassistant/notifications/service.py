"""Notifications on every device of an account, kept on the server (#353).

The server keeps every notification and whether it has been read; the clients
only display them. ``notify`` is the one way in — the assistant's ``notify_user``
tool calls it, and so do calendar reminders as they fall due. It stores the
notification first, then hands it to every ``/ws/notifications`` socket the
account has open — the desktop's tray process holds one, so a closed window
still hears it — and pushes it to every registered phone through Firebase
Cloud Messaging (``push.py``), whose app is not running to hold a socket.

``mark_read`` is the one way out. Reading a notification on any device — tapping
it, reading it in the app's list, reading them all, or opening the conversation
or reminder it points to — sets ``read_at`` once and tells every device, which
then drop it. A device that was away is sent what is still unread when it
reconnects (``unread``), so it shows what it missed and clears what was read.

``notify`` never raises into its caller: a reminder that could not be delivered
must not fail the scan that found it, nor a tool call the turn that made it. A
failure is logged with its traceback instead.
"""

import logging
from datetime import datetime, timedelta
from typing import Iterable, List, Optional, Tuple

from kurisuassistant.db.service import get_db_service
from kurisuassistant.notifications import push
from kurisuassistant.notifications.hub import hub

logger = logging.getLogger(__name__)

SOURCES = ("assistant", "calendar")

# What a notification is shown as when it is not the assistant's.
CALENDAR_SENDER = "Calendar"
# The assistant with no persona in use (#302) — the name it answers under.
ASSISTANT_SENDER = "Assistant"

# A notification is a short message; anything longer is the conversation's job.
TITLE_LIMIT = 120
BODY_LIMIT = 1000

# What a reconnecting device is sent: the newest this many unread, from this far
# back. Older unread ones stay in the app's list but are not worth a system
# notification any more.
UNREAD_SYNC_LIMIT = 50
UNREAD_SYNC_WINDOW = timedelta(days=7)

PAGE_LIMIT = 100


def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() + "Z" if value is not None else None


def _sender(session, user_id: int, source: str) -> str:
    if source == "calendar":
        return CALENDAR_SENDER
    from kurisuassistant.db.models import Assistant, Persona

    persona = (
        session.query(Persona)
        .join(Assistant, Assistant.selected_persona_id == Persona.id)
        .filter(Assistant.user_id == user_id, Persona.enabled.is_(True))
        .one_or_none()
    )
    return persona.name if persona is not None else ASSISTANT_SENDER


def to_event(row) -> dict:
    return {
        "type": "notification",
        "id": row.id,
        "source": row.source,
        "sender": row.sender,
        "title": row.title,
        "body": row.body,
        "conversation_id": row.conversation_id,
        "reminder_id": row.reminder_id,
        "created_at": _iso(row.created_at),
        "read_at": _iso(row.read_at),
    }


async def _store(
    user_id: int,
    source: str,
    title: str,
    body: str,
    conversation_id: Optional[int],
    reminder_id: Optional[int],
) -> dict:
    from kurisuassistant.db.models import Conversation, Notification

    def _write(session):
        # Only the account's own conversation may be linked: the id comes from a
        # tool call, and a notification must never open someone else's chat.
        linked = conversation_id
        if linked is not None:
            owned = session.query(Conversation.id).filter_by(id=linked, user_id=user_id).one_or_none()
            linked = linked if owned is not None else None
        row = Notification(
            user_id=user_id,
            source=source,
            sender=_sender(session, user_id, source),
            title=title[:TITLE_LIMIT],
            body=body[:BODY_LIMIT],
            conversation_id=linked,
            reminder_id=reminder_id,
            created_at=datetime.utcnow(),
        )
        session.add(row)
        session.flush()
        return to_event(row)

    return await get_db_service().execute(_write)


async def notify(
    user_id: int,
    *,
    source: str,
    title: str,
    body: str,
    conversation_id: Optional[int] = None,
    reminder_id: Optional[int] = None,
) -> None:
    """Notify every device of ``user_id``. ``source`` is "assistant" or "calendar"."""
    try:
        if source not in SOURCES:
            raise ValueError(f"unknown notification source {source!r}")
        event = await _store(user_id, source, (title or "").strip(), (body or "").strip(), conversation_id, reminder_id)
    except Exception:
        logger.error("Could not send a notification to user %s", user_id, exc_info=True)
        return
    hub.publish(user_id, event)
    try:
        await push.send_notification(user_id, event)
    except Exception:
        logger.error("Could not push a notification to the phones of user %s", user_id, exc_info=True)


async def unread(user_id: int) -> List[dict]:
    """What a connecting device is sent: the recent unread, oldest first."""
    from kurisuassistant.db.models import Notification

    def _read(session):
        rows = (
            session.query(Notification)
            .filter(
                Notification.user_id == user_id,
                Notification.read_at.is_(None),
                Notification.created_at >= datetime.utcnow() - UNREAD_SYNC_WINDOW,
            )
            .order_by(Notification.id.desc())
            .limit(UNREAD_SYNC_LIMIT)
            .all()
        )
        return [to_event(row) for row in reversed(rows)]

    return await get_db_service().execute(_read)


async def page(user_id: int, *, unread_only: bool, limit: int, offset: int) -> Tuple[List[dict], int]:
    """The account's notifications, unread first then newest first, and how many are unread."""
    from sqlalchemy import func

    from kurisuassistant.db.models import Notification

    def _read(session):
        query = session.query(Notification).filter(Notification.user_id == user_id)
        if unread_only:
            query = query.filter(Notification.read_at.is_(None))
        rows = (
            query.order_by(Notification.read_at.isnot(None), Notification.id.desc())
            .offset(offset)
            .limit(limit)
            .all()
        )
        count = (
            session.query(func.count(Notification.id))
            .filter(Notification.user_id == user_id, Notification.read_at.is_(None))
            .scalar()
        )
        return [to_event(row) for row in rows], count

    return await get_db_service().execute(_read)


async def mark_read(
    user_id: int,
    *,
    ids: Optional[Iterable[int]] = None,
    all_unread: bool = False,
    conversation_id: Optional[int] = None,
    reminder_id: Optional[int] = None,
) -> Tuple[List[int], Optional[str]]:
    """Read the account's unread notifications that match, and tell every device.

    Exactly one of ``ids``, ``all_unread``, ``conversation_id`` or ``reminder_id``
    says which. Returns the ids this call read — already-read ones are left as
    they were and are not announced again — and the time they were read.
    """
    from kurisuassistant.db.models import Notification

    wanted = list(ids) if ids is not None else None

    def _write(session):
        query = session.query(Notification).filter(
            Notification.user_id == user_id, Notification.read_at.is_(None),
        )
        if wanted is not None:
            query = query.filter(Notification.id.in_(wanted))
        elif conversation_id is not None:
            query = query.filter(Notification.conversation_id == conversation_id)
        elif reminder_id is not None:
            query = query.filter(Notification.reminder_id == reminder_id)
        elif not all_unread:
            return [], None
        rows = query.order_by(Notification.id).all()
        now = datetime.utcnow()
        for row in rows:
            row.read_at = now
        return [row.id for row in rows], (_iso(now) if rows else None)

    read_ids, read_at = await get_db_service().execute(_write)
    if read_ids:
        hub.publish(user_id, {"type": "notifications_read", "ids": read_ids, "read_at": read_at})
        try:
            await push.send_read(user_id, read_ids)
        except Exception:
            logger.error("Could not push a read to the phones of user %s", user_id, exc_info=True)
    return read_ids, read_at


async def get(user_id: int, notification_id: int) -> Optional[dict]:
    """One of the account's notifications, or None — another account's is None too."""
    from kurisuassistant.db.models import Notification

    def _read(session):
        row = session.query(Notification).filter_by(id=notification_id, user_id=user_id).one_or_none()
        return to_event(row) if row is not None else None

    return await get_db_service().execute(_read)
