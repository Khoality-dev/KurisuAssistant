"""WebSocket connection manager."""

import logging
from typing import Dict, Optional, Set, TYPE_CHECKING
from fastapi import WebSocket

if TYPE_CHECKING:
    from websocket.handlers import ChatSessionHandler

logger = logging.getLogger(__name__)


class ConnectionManager:
    """Manages WebSocket connections and chat handlers per user."""

    def __init__(self):
        # username -> set of active WebSocket connections
        self._connections: Dict[str, Set[WebSocket]] = {}
        # user_id -> persistent ChatSessionHandler (survives reconnects)
        self._handlers: Dict[int, "ChatSessionHandler"] = {}

    async def connect(self, websocket: WebSocket, username: str) -> None:
        """Accept and register a new WebSocket connection."""
        await websocket.accept()

        if username not in self._connections:
            self._connections[username] = set()

        self._connections[username].add(websocket)
        logger.debug(f"WebSocket connected for user: {username}")

    def disconnect(self, websocket: WebSocket, username: str) -> None:
        """Remove a WebSocket connection."""
        if username in self._connections:
            self._connections[username].discard(websocket)
            if not self._connections[username]:
                del self._connections[username]
        logger.debug(f"WebSocket disconnected for user: {username}")

    def get_handler(self, user_id: int) -> Optional["ChatSessionHandler"]:
        """Get existing handler for a user."""
        return self._handlers.get(user_id)

    def set_handler(self, user_id: int, handler: "ChatSessionHandler") -> None:
        """Register a handler for a user."""
        self._handlers[user_id] = handler

    def remove_handler(self, user_id: int) -> None:
        """Remove handler for a user."""
        self._handlers.pop(user_id, None)

    async def send_to_user(self, username: str, data: dict) -> None:
        """Send data to all connections for a user."""
        if username in self._connections:
            for ws in self._connections[username]:
                try:
                    await ws.send_json(data)
                except Exception as e:
                    logger.error(f"Error sending to WebSocket: {e}")

    def get_connection_count(self, username: str) -> int:
        """Get number of active connections for a user."""
        return len(self._connections.get(username, set()))

    def is_connected(self, username: str) -> bool:
        """Check if user has any active connections."""
        return username in self._connections and len(self._connections[username]) > 0


# Global connection manager instance
manager = ConnectionManager()
