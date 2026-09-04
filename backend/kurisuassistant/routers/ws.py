"""WebSocket router for real-time chat."""

import logging
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from kurisuassistant.core.security import get_current_user
from kurisuassistant.websocket.manager import manager
from kurisuassistant.websocket.handlers import ChatSessionHandler
from kurisuassistant.db.service import get_db_service
from kurisuassistant.db.repositories import UserRepository

logger = logging.getLogger(__name__)

router = APIRouter()

# Browsers cannot set headers on a WebSocket, so a browser-based client passes
# the token as the second entry of the subprotocol list. The server selects this
# marker so the handshake completes.
WS_AUTH_SUBPROTOCOL = "kurisu.auth.bearer"


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


@router.websocket("/ws/chat")
async def websocket_chat(websocket: WebSocket):
    """WebSocket endpoint for real-time chat.

    The client authenticates during the handshake, either with an Authorization
    header or with the `kurisu.auth.bearer` subprotocol.
    """
    token, subprotocol = _extract_token(websocket)

    async def reject(reason: str) -> None:
        # A close frame is only delivered after the handshake completes, so the
        # socket has to be accepted before it can be refused with a reason.
        await websocket.accept(subprotocol=subprotocol)
        await websocket.close(code=4001, reason=reason)

    if not token:
        logger.info("WS rejected: no credentials in the handshake")
        return await reject("Unauthorized")

    username = get_current_user(token)
    if not username:
        return await reject("Unauthorized")

    def _get_user_id(session):
        user_repo = UserRepository(session)
        user = user_repo.get_by_username(username)
        return user.id if user else None

    db = get_db_service()
    user_id = await db.execute(_get_user_id)
    if user_id is None:
        return await reject("User not found")

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
