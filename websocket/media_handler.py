"""Dedicated WebSocket handler for media streaming."""

import logging
from fastapi import WebSocket

from .events import (
    BaseEvent,
    MediaPlayEvent,
    MediaPauseEvent,
    MediaResumeEvent,
    MediaSkipEvent,
    MediaStopEvent,
    MediaQueueAddEvent,
    MediaQueueRemoveEvent,
    MediaVolumeEvent,
    MediaErrorEvent,
    parse_event,
)
from media import get_media_player

logger = logging.getLogger(__name__)


class MediaSessionHandler:
    """Handles a dedicated media WebSocket session.

    Receives media control events and streams audio chunks
    on a separate connection from chat/TTS/vision.
    """

    def __init__(self, websocket: WebSocket, user_id: int):
        self.websocket = websocket
        self.user_id = user_id

    async def run(self):
        """Main handler loop — receive and dispatch media events."""
        from fastapi import WebSocketDisconnect

        # Register player with our send callback
        get_media_player(self.user_id, self.send_event)

        while True:
            try:
                data = await self.websocket.receive_json()
                event = parse_event(data)
                await self._handle_event(event)
            except WebSocketDisconnect:
                raise
            except Exception as e:
                logger.error(f"Media WebSocket error: {e}", exc_info=True)
                await self.send_event(MediaErrorEvent(error=str(e)))

    async def _handle_event(self, event: BaseEvent):
        """Route media event to player."""
        player = get_media_player(self.user_id, self.send_event)

        if isinstance(event, MediaPlayEvent):
            await player.play(event.query)
        elif isinstance(event, MediaPauseEvent):
            await player.pause()
        elif isinstance(event, MediaResumeEvent):
            await player.resume()
        elif isinstance(event, MediaSkipEvent):
            await player.skip()
        elif isinstance(event, MediaStopEvent):
            await player.stop()
        elif isinstance(event, MediaQueueAddEvent):
            await player.add_to_queue(event.query)
        elif isinstance(event, MediaQueueRemoveEvent):
            player.remove_from_queue(event.index)
        elif isinstance(event, MediaVolumeEvent):
            player.set_volume(event.volume)

    async def send_event(self, event: BaseEvent):
        """Send event to media WebSocket client (silently fails if disconnected)."""
        try:
            if self.websocket.client_state.name == "CONNECTED":
                await self.websocket.send_json(event.to_dict())
        except Exception as e:
            logger.debug(f"Failed to send media WebSocket event: {e}")
