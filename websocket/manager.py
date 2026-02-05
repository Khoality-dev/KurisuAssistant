"""WebSocket connection manager."""

import logging
from typing import Dict, Set
from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    """Manages WebSocket connections per user."""

    def __init__(self):
        # username -> set of active WebSocket connections
        self._connections: Dict[str, Set[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, username: str) -> None:
        """Accept and register a new WebSocket connection."""
        await websocket.accept()

        if username not in self._connections:
            self._connections[username] = set()

        self._connections[username].add(websocket)
        logger.info(f"WebSocket connected for user: {username}")

    def disconnect(self, websocket: WebSocket, username: str) -> None:
        """Remove a WebSocket connection."""
        if username in self._connections:
            self._connections[username].discard(websocket)
            if not self._connections[username]:
                del self._connections[username]
        logger.info(f"WebSocket disconnected for user: {username}")

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
