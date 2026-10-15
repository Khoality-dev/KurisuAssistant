"""Notifications, as the server keeps them (#353).

The server keeps every notification and whether it has been read; the clients
only display them. These routes are the list a client shows and the ways to
read: one, all, or every one pointing at a conversation or a reminder the user
just opened. Each read is announced on ``/ws/notifications`` as
``notifications_read`` and pushed to the phones, so every other device drops it
too. ``/devices`` is where a phone registers its FCM token for that push.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, model_validator

from kurisuassistant.core.deps import get_authenticated_user
from kurisuassistant.db.models import User
from kurisuassistant.db.service import get_db_service
from kurisuassistant.notifications import push, service

router = APIRouter(prefix="/notifications", tags=["notifications"])


class ReadFor(BaseModel):
    """What the user opened: a conversation, or a calendar reminder."""

    conversation_id: Optional[int] = None
    reminder_id: Optional[int] = None

    @model_validator(mode="after")
    def _one_target(self):
        if (self.conversation_id is None) == (self.reminder_id is None):
            raise ValueError("name exactly one of conversation_id or reminder_id")
        return self


class DeviceRegistration(BaseModel):
    """A phone's FCM token, sent while its notifications are on."""

    platform: str = Field(min_length=1, max_length=32)
    fcm_token: str = Field(min_length=1, max_length=4096)


@router.post("/devices")
async def register_device(body: DeviceRegistration, user: User = Depends(get_authenticated_user)):
    """Register or refresh this phone for push; the token is this account's from now on."""
    await get_db_service().execute(push.register(user.id, body.platform, body.fcm_token))
    return {"registered": True, "push": push.enabled()}


@router.delete("/devices/{fcm_token}")
async def unregister_device(fcm_token: str, user: User = Depends(get_authenticated_user)):
    """Stop pushing to this phone — its notifications were turned off, or it signed out."""
    if not await get_db_service().execute(push.unregister(user.id, fcm_token)):
        raise HTTPException(status_code=404, detail="Device not found")
    return {"unregistered": True}


@router.get("")
async def list_notifications(
    unread: bool = False,
    limit: int = Query(50, ge=1, le=service.PAGE_LIMIT),
    offset: int = Query(0, ge=0),
    user: User = Depends(get_authenticated_user),
):
    """Unread first, then newest first; ``unread=true`` lists only those."""
    rows, unread_count = await service.page(user.id, unread_only=unread, limit=limit, offset=offset)
    return {"notifications": rows, "unread_count": unread_count}


@router.post("/read-all")
async def read_all(user: User = Depends(get_authenticated_user)):
    ids, read_at = await service.mark_read(user.id, all_unread=True)
    return {"ids": ids, "read_at": read_at}


@router.post("/read-for")
async def read_for(body: ReadFor, user: User = Depends(get_authenticated_user)):
    """Read every unread notification pointing at what the user just opened."""
    ids, read_at = await service.mark_read(
        user.id, conversation_id=body.conversation_id, reminder_id=body.reminder_id,
    )
    return {"ids": ids, "read_at": read_at}


@router.post("/{notification_id}/read")
async def read_one(notification_id: int, user: User = Depends(get_authenticated_user)):
    """Read one. Reading it again changes nothing and announces nothing."""
    await service.mark_read(user.id, ids=[notification_id])
    notification = await service.get(user.id, notification_id)
    if notification is None:
        raise HTTPException(status_code=404, detail="Notification not found")
    return notification
