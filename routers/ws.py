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
    existing = handler is not None
    if handler and (
        (handler.current_task and not handler.current_task.done())
        or handler._accumulated_messages
        or handler._current_chunk
    ):
        # Reconnect: swap socket on existing handler, replay accumulated state
        logger.info(f"WS [{username}] Reconnecting to existing handler (task={handler.current_task is not None}, accumulated={len(handler._accumulated_messages)}, chunk={handler._current_chunk is not None})")
        await handler.replace_websocket(websocket)
    else:
        # Fresh connection: create new handler
        logger.info(f"WS [{username}] Fresh connection (existing_handler={existing})")
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


