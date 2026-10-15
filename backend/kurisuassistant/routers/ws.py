"""WebSocket routers: the chat (``/ws/chat``) and notifications (``/ws/notifications``)."""

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from kurisuassistant.core.accounts import ACCOUNT_INACTIVE_DETAIL
from kurisuassistant.core.security import get_current_user
from kurisuassistant.version import WIRE_PROTOCOL
from kurisuassistant.websocket.manager import manager
from kurisuassistant.websocket.handlers import ChatSessionHandler
from kurisuassistant.db.service import get_db_service
from kurisuassistant.db.repositories import UserRepository
from kurisuassistant.notifications import service as notifications
from kurisuassistant.notifications.hub import hub as notification_hub

logger = logging.getLogger(__name__)

router = APIRouter()

# Browsers cannot set headers on a WebSocket, so a browser-based client passes
# the token as the second entry of the subprotocol list. The server selects this
# marker so the handshake completes.
WS_AUTH_SUBPROTOCOL = "kurisu.auth.bearer"

# Same trick for the wire protocol: a browser cannot set `X-Wire-Protocol` on a
# WebSocket either, so it may declare the version as a third subprotocol entry,
# `kurisu.wire.<n>`. Only `kurisu.auth.bearer` is ever echoed back on accept.
WS_WIRE_PROTOCOL_PREFIX = "kurisu.wire."

# Close code for a protocol mismatch. 4000-4999 is the application-defined range;
# 4426 echoes the HTTP 426 the REST middleware answers with.
WS_WIRE_PROTOCOL_MISMATCH = 4426

# What a client's `int()` cannot be parsed to, kept distinct from "did not say".
_UNREADABLE_PROTOCOL = -1


def _extract_token(websocket: WebSocket) -> tuple[Optional[str], Optional[str]]:
    """Return (token, subprotocol_to_echo) from the handshake.

    The token used to arrive as a query parameter, which put a 30-day-refreshable
    credential into every proxy access log and browser history entry. Two carriers
    replace it:

    * ``Authorization: Bearer <token>`` — for clients that control their headers,
      such as the Android client's OkHttp stack.
    * ``Sec-WebSocket-Protocol: kurisu.auth.bearer, <token>`` — for browser
      contexts, where the WebSocket API exposes no other channel. The selected
      subprotocol has to be echoed on accept or the browser drops the connection.
    """
    authorization = websocket.headers.get("authorization")
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[len("bearer "):].strip()
        if token:
            return token, None

    offered = websocket.headers.get("sec-websocket-protocol")
    if offered:
        parts = [p.strip() for p in offered.split(",") if p.strip()]
        if len(parts) >= 2 and parts[0] == WS_AUTH_SUBPROTOCOL:
            return parts[1], WS_AUTH_SUBPROTOCOL

    return None, None


def _extract_wire_protocol(websocket: WebSocket) -> Optional[int]:
    """Return the wire protocol the client claims, or None if it did not say.

    main.py enforces `X-Wire-Protocol` on HTTP only, so before this check a stale
    client that was refused every REST call could still open the socket and be fed
    event shapes it does not understand — silent garbage, which is the one thing
    the protocol number exists to prevent. Absence is still allowed, exactly as it
    is over HTTP, so curl and internal tooling keep working.
    """
    raw = websocket.headers.get("x-wire-protocol")
    if raw is None:
        offered = websocket.headers.get("sec-websocket-protocol") or ""
        for part in (p.strip() for p in offered.split(",")):
            if part.startswith(WS_WIRE_PROTOCOL_PREFIX):
                raw = part[len(WS_WIRE_PROTOCOL_PREFIX):]
                break
    if raw is None:
        return None
    try:
        return int(raw)
    except ValueError:
        return _UNREADABLE_PROTOCOL


async def _authenticate(websocket: WebSocket) -> Optional[tuple[int, Optional[str], str]]:
    """The handshake both sockets share: wire protocol, then credentials, then activation.

    Returns ``(user_id, subprotocol_to_echo, username)``, or None after refusing
    the socket with its close code: 4426 for a mismatched wire protocol (checked
    before anything about the caller), 4001 otherwise.
    """
    token, subprotocol = _extract_token(websocket)

    async def reject(reason: str, code: int = 4001) -> None:
        # A close frame is only delivered after the handshake completes, so the
        # socket has to be accepted before it can be refused with a reason.
        await websocket.accept(subprotocol=subprotocol)
        await websocket.close(code=code, reason=reason)

    # Before authentication: a stale client should be told to update whether or not
    # its token is still good, and the answer does not depend on who it is.
    client_protocol = _extract_wire_protocol(websocket)
    if client_protocol is not None and client_protocol != WIRE_PROTOCOL:
        logger.info(
            "WS rejected: client wire protocol %s, server speaks %s",
            client_protocol, WIRE_PROTOCOL,
        )
        await reject(
            f"wire_protocol_mismatch (server {WIRE_PROTOCOL})",
            code=WS_WIRE_PROTOCOL_MISMATCH,
        )
        return None

    if not token:
        logger.info("WS rejected: no credentials in the handshake")
        await reject("Unauthorized")
        return None

    username = get_current_user(token)
    if not username:
        await reject("Unauthorized")
        return None

    def _get_user_id(session):
        user_repo = UserRepository(session)
        user = user_repo.get_by_username(username)
        if not user:
            return None
        # The socket authenticates on its own, so the activation gate in
        # `get_authenticated_user` does not cover it. An unactivated account
        # holding a valid token must not get a session.
        return user.id if user.is_active else False

    db = get_db_service()
    user_id = await db.execute(_get_user_id)
    if user_id is None:
        await reject("User not found")
        return None
    if user_id is False:
        logger.info("WS rejected: account '%s' is not activated", username)
        await reject(ACCOUNT_INACTIVE_DETAIL)
        return None
    return user_id, subprotocol, username


@router.websocket("/ws/chat")
async def websocket_chat(websocket: WebSocket):
    """WebSocket endpoint for real-time chat.

    The client authenticates during the handshake, either with an Authorization
    header or with the `kurisu.auth.bearer` subprotocol, and declares its wire
    protocol with an `X-Wire-Protocol` header or a `kurisu.wire.<n>` subprotocol.
    """
    authenticated = await _authenticate(websocket)
    if authenticated is None:
        return
    user_id, subprotocol, username = authenticated

    await manager.connect(websocket, user_id, subprotocol=subprotocol)

    # Sessions are last-one-wins: the handler is shared and writes to one socket,
    # so an earlier connection would sit attached but never written to.
    await manager.displace_existing(user_id, keep=websocket)

    # Reuse existing handler if one exists (preserves vision/media state)
    handler = manager.get_handler(user_id)
    if handler:
        logger.info(f"WS [{username}] Reconnecting to existing handler")
        await handler.replace_websocket(websocket)
    else:
        logger.info(f"WS [{username}] Fresh connection")
        handler = ChatSessionHandler(websocket, user_id)
        manager.set_handler(user_id, handler)

    # Always send state snapshot (works for both fresh and reconnect)
    await handler.send_connected_state()

    try:
        logger.info(f"WS [{username}] Entering handler.run()")
        await handler.run()
        logger.info(f"WS [{username}] handler.run() returned normally")
    except WebSocketDisconnect:
        logger.info(f"WS [{username}] WebSocketDisconnect")
    except Exception as e:
        logger.error(f"WS [{username}] Error: {e}", exc_info=True)
    finally:
        logger.info(f"WS [{username}] Cleaning up")
        evicted = manager.disconnect(websocket, user_id)
        if evicted is not None:
            await evicted.shutdown()


@router.websocket("/ws/notifications")
async def websocket_notifications(websocket: WebSocket):
    """Every device of the account, listening for notifications (#353).

    The same handshake as the chat, but none of its exclusivity: the phone's
    background service and the desktop's tray process each hold one, alongside
    whatever chat socket is open, and none displaces another. Server to client
    only — anything the client sends is ignored.

    On connect, ``notifications_ready`` carries what is unread (the last week, at
    most 50, oldest first): a device that was away shows the ones it has not
    shown and drops the ones read meanwhile. Then each ``notification`` as it is
    sent, and each ``notifications_read`` as any device reads some.
    """
    authenticated = await _authenticate(websocket)
    if authenticated is None:
        return
    user_id, subprotocol, username = authenticated

    await websocket.accept(subprotocol=subprotocol)
    # Subscribed before the snapshot is read, so nothing sent in between is
    # lost; a notification both would deliver is sent once.
    queue = notification_hub.subscribe(user_id)
    try:
        snapshot = await notifications.unread(user_id)
        await websocket.send_json({"type": "notifications_ready", "unread": snapshot})
        in_snapshot = {event["id"] for event in snapshot}

        async def forward() -> None:
            while True:
                event = await queue.get()
                if event["type"] == "notification" and event["id"] in in_snapshot:
                    continue
                await websocket.send_json(event)

        async def drain() -> None:
            while True:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    return

        tasks = [asyncio.create_task(forward()), asyncio.create_task(drain())]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                if not task.cancelled() and task.exception() is not None:
                    raise task.exception()
        finally:
            for task in tasks:
                task.cancel()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.error("Notifications socket for '%s' failed", username, exc_info=True)
    finally:
        notification_hub.unsubscribe(user_id, queue)
