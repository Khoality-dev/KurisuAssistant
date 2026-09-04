"""WebSocket connection manager."""

import logging
from typing import Dict, Optional, Set, TYPE_CHECKING
from fastapi import WebSocket

if TYPE_CHECKING:
    from kurisuassistant.websocket.handlers import ChatSessionHandler

logger = logging.getLogger(__name__)

# Sent to a session that is displaced when the same account connects elsewhere.
WS_SUPERSEDED_CODE = 4003


class ConnectionManager:
    """Manages WebSocket connections and chat handlers per user.

    Connections and handlers are both keyed by ``user_id``. They used to be keyed
    differently — connections by username, handlers by id — which made it easy to
    clean up one and leave the other behind, and that is exactly what happened:
    nothing ever removed a handler.

    A handler survives a reconnect on purpose, so a dropped connection can rejoin
    a running turn. It does not survive the last connection going away.
    """

    def __init__(self):
        self._connections: Dict[int, Set[WebSocket]] = {}
        self._handlers: Dict[int, "ChatSessionHandler"] = {}

    async def connect(
        self, websocket: WebSocket, user_id: int, subprotocol: Optional[str] = None
    ) -> None:
        """Accept and register a new WebSocket connection.

        ``subprotocol`` must be echoed back when the client authenticated through
        the subprotocol header, or the browser closes the connection.
        """
        await websocket.accept(subprotocol=subprotocol)
        self._connections.setdefault(user_id, set()).add(websocket)
        logger.debug("WebSocket connected for user %s", user_id)

    def disconnect(self, websocket: WebSocket, user_id: int) -> Optional["ChatSessionHandler"]:
        """Remove a connection, and the handler with it if that was the last one.

        Returns the handler that was evicted, so the caller can shut it down.
        """
        connections = self._connections.get(user_id)
        if connections is not None:
            connections.discard(websocket)
            if not connections:
                del self._connections[user_id]

        logger.debug("WebSocket disconnected for user %s", user_id)

        if user_id not in self._connections:
            handler = self._handlers.pop(user_id, None)
            if handler is not None:
                logger.info("Last connection closed for user %s — evicting handler", user_id)
            return handler
        return None

    async def displace_existing(self, user_id: int, keep: WebSocket) -> None:
        """Close any other live socket for this account.

        Sessions are last-one-wins. The handler is shared and writes to exactly
        one socket, so a second connection previously left the first one attached
        but unwritten-to, with two read loops running against the same handler.
        Closing it makes that explicit instead of emergent.
        """
        for websocket in list(self._connections.get(user_id, set())):
            if websocket is keep:
                continue
            try:
                await websocket.close(code=WS_SUPERSEDED_CODE, reason="Session opened elsewhere")
                logger.info("Displaced an earlier session for user %s", user_id)
            except Exception:
                logger.debug("Could not close a displaced socket", exc_info=True)
            self._connections.get(user_id, set()).discard(websocket)

    def get_handler(self, user_id: int) -> Optional["ChatSessionHandler"]:
        """Get existing handler for a user."""
        return self._handlers.get(user_id)

    def set_handler(self, user_id: int, handler: "ChatSessionHandler") -> None:
        """Register a handler for a user."""
        self._handlers[user_id] = handler

    def remove_handler(self, user_id: int) -> Optional["ChatSessionHandler"]:
        """Remove and return a user's handler."""
        return self._handlers.pop(user_id, None)

    async def send_to_user(self, user_id: int, data: dict) -> None:
        """Send data to all live connections for a user.

        Iterates a snapshot: a send that fails triggers cleanup elsewhere, which
        mutates the set, and mutating a set mid-iteration raises. Sockets that
        fail are dropped rather than retried on every later broadcast.
        """
        failed = []
        for websocket in list(self._connections.get(user_id, set())):
            try:
                await websocket.send_json(data)
            except Exception as e:
                logger.debug("Dropping a WebSocket that failed to receive: %s", e)
                failed.append(websocket)

        if failed:
            connections = self._connections.get(user_id)
            if connections is not None:
                for websocket in failed:
                    connections.discard(websocket)
                if not connections:
                    del self._connections[user_id]

    def get_connection_count(self, user_id: int) -> int:
        """Get number of active connections for a user."""
        return len(self._connections.get(user_id, set()))

    def is_connected(self, user_id: int) -> bool:
        """Check if user has any active connections."""
        return bool(self._connections.get(user_id))


# Global connection manager instance
manager = ConnectionManager()
