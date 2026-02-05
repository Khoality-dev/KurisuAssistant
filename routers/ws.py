"""WebSocket router for real-time chat."""

import logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

from core.security import get_current_user
from websocket.manager import manager
from websocket.handlers import ChatSessionHandler

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
        await websocket.close(code=4001, reason="Unauthorized")
        return

    # Connect
    await manager.connect(websocket, username)

    # Create session handler
    handler = ChatSessionHandler(websocket, username)

    try:
        await handler.run()
    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for user: {username}")
    except Exception as e:
        logger.error(f"WebSocket error for user {username}: {e}", exc_info=True)
    finally:
        manager.disconnect(websocket, username)
