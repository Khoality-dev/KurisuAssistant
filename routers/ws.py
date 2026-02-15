"""WebSocket router for real-time chat."""

import logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

from core.security import get_current_user
from websocket.manager import manager
from websocket.handlers import ChatSessionHandler
from db.session import get_session
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
    with get_session() as session:
        user_repo = UserRepository(session)
        user = user_repo.get_by_username(username)
        if not user:
            await websocket.accept()
            await websocket.close(code=4001, reason="User not found")
            return
        user_id = user.id

    # Connect
    await manager.connect(websocket, username)

    # Reuse existing handler if it has state to replay (reconnect scenario)
    handler = manager.get_handler(user_id)
    if handler and (
        (handler.current_task and not handler.current_task.done())
        or handler._accumulated_messages
        or handler._current_chunk
    ):
        # Reconnect: swap socket on existing handler, replay accumulated state
        logger.debug(f"Reconnecting user {username} to existing handler with accumulated state")
        await handler.replace_websocket(websocket)
    else:
        # Fresh connection: create new handler
        handler = ChatSessionHandler(websocket, user_id)
        manager.set_handler(user_id, handler)

    try:
        await handler.run()
    except WebSocketDisconnect:
        logger.debug(f"WebSocket disconnected for user: {username}")
    except Exception as e:
        logger.error(f"WebSocket error for user {username}: {e}", exc_info=True)
    finally:
        manager.disconnect(websocket, username)
