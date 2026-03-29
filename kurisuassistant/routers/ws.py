"""WebSocket router for real-time chat with multi-device support."""

import asyncio
import logging
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

from kurisuassistant.core.security import get_current_user
from kurisuassistant.websocket.manager import manager
from kurisuassistant.websocket.handlers import ChatSessionHandler, HEARTBEAT_INTERVAL, HEARTBEAT_TIMEOUT
from kurisuassistant.db.service import get_db_service
from kurisuassistant.db.repositories import UserRepository, DeviceRepository

logger = logging.getLogger(__name__)

router = APIRouter()


@router.websocket("/ws/chat")
async def websocket_chat(
    websocket: WebSocket,
    token: str = Query(...),
    hostname: str = Query("unknown"),
    platform: str = Query("unknown"),
):
    """WebSocket endpoint for real-time chat.

    Client must provide JWT token as query parameter.
    Optionally provides hostname and platform for device tracking.
    """
    # Authenticate user
    username = get_current_user(token)
    if not username:
        await websocket.accept()
        await websocket.close(code=4001, reason="Unauthorized")
        return

    # Get user ID and register device
    def _get_user_and_device(session):
        user_repo = UserRepository(session)
        user = user_repo.get_by_username(username)
        if not user:
            return None, None
        device_repo = DeviceRepository(session)
        device = device_repo.get_or_create(user.id, hostname, platform)
        return user.id, device.name

    db = get_db_service()
    user_id, device_name = await db.execute(_get_user_and_device)
    if user_id is None:
        await websocket.accept()
        await websocket.close(code=4001, reason="User not found")
        return

    # Connect
    await manager.connect(websocket, username)

    # Reuse existing handler if one exists (preserves vision/media state)
    handler = manager.get_handler(user_id)
    if handler:
        logger.info(f"WS [{username}] Device '{device_name}' joining existing handler")
    else:
        logger.info(f"WS [{username}] Fresh connection from device '{device_name}'")
        handler = ChatSessionHandler(user_id)
        manager.set_handler(user_id, handler)

    handler.add_connection(device_name, websocket)

    # Send state snapshot to this specific connection
    await handler.send_connected_state_to(websocket, device_name=device_name)

    # Per-connection heartbeat + receive loop
    last_pong_time = time.monotonic()

    async def _heartbeat_loop():
        nonlocal last_pong_time
        try:
            while True:
                await asyncio.sleep(HEARTBEAT_INTERVAL)
                try:
                    state = websocket.client_state.name
                    if state == "CONNECTED":
                        await websocket.send_json({"type": "ping"})
                    else:
                        return
                except Exception:
                    return
                await asyncio.sleep(HEARTBEAT_TIMEOUT)
                if time.monotonic() - last_pong_time > HEARTBEAT_INTERVAL + HEARTBEAT_TIMEOUT:
                    logger.warning("Heartbeat timeout for device '%s' user %d", device_name, user_id)
                    try:
                        await websocket.close(code=4002, reason="Heartbeat timeout")
                    except Exception:
                        pass
                    return
        except asyncio.CancelledError:
            pass

    heartbeat_task = asyncio.create_task(_heartbeat_loop())

    try:
        while True:
            try:
                data = await websocket.receive_json()
                msg_type = data.get("type")
                if msg_type == "pong":
                    last_pong_time = time.monotonic()
                    continue
                await handler.handle_message(data, device_name)
            except WebSocketDisconnect:
                raise
            except RuntimeError:
                raise WebSocketDisconnect()
    except WebSocketDisconnect:
        logger.info(f"WS [{username}] Device '{device_name}' disconnected")
    except Exception as e:
        logger.error(f"WS [{username}] Device '{device_name}' error: {e}", exc_info=True)
    finally:
        heartbeat_task.cancel()
        handler.remove_connection(device_name)
        if not handler.has_connections():
            manager.remove_handler(user_id)
        manager.disconnect(websocket, username)
