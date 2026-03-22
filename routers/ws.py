"""WebSocket router for real-time chat."""

import logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

from core.security import get_current_user
from websocket.manager import manager
from websocket.handlers import ChatSessionHandler
from db.service import get_db_service
from db.repositories import UserRepository

logger = logging.getLogger(__name__)

router = APIRouter()


@router.websocket("/ws/chat")
async def websocket_chat(
    websocket: WebSocket,
    token: str = Query(...),
):
    """WebSocket endpoint for real-time chat.

    Client must provide JWT token as query parameter.
    """
    # Authenticate user
    username = get_current_user(token)
    if not username:
        await websocket.accept()
        await websocket.close(code=4001, reason="Unauthorized")
        return

    # Get user ID from username
    def _get_user_id(session):
        user_repo = UserRepository(session)
        user = user_repo.get_by_username(username)
        return user.id if user else None

    db = get_db_service()
    user_id = await db.execute(_get_user_id)
    if user_id is None:
        await websocket.accept()
        await websocket.close(code=4001, reason="User not found")
        return

    # Connect
    await manager.connect(websocket, username)

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
        manager.disconnect(websocket, username)


