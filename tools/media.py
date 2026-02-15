"""Media player tools for LLM agents."""

import json
import logging
from typing import Dict, Any

from .base import BaseTool
from media.player import get_media_player, _players, PlaybackState

logger = logging.getLogger(__name__)


def _get_player(args: Dict[str, Any]):
    """Get or create the MediaPlayer for the current user.

    If a media WebSocket is connected, the player already exists in the registry.
    Otherwise, fall back to creating one that sends events through the chat handler's
    WebSocket. When the media WebSocket connects later, it updates the send callback.
    """
    user_id = args.get("user_id")
    if not user_id:
        return None

    # Player already exists in registry (media WS connected, or previous tool call)
    if user_id in _players:
        return _players[user_id]

    # Fall back: create player using chat handler's send_event
    handler = args.get("_handler")
    if not handler:
        return None

    return get_media_player(user_id, handler.send_event)


class PlayMusicTool(BaseTool):
    """Search YouTube and play or enqueue a track."""

    name = "play_music"
    description = (
        "Search YouTube for music and play it for the user. "
        "If something is already playing, the track is added to the queue. "
        "Use when the user asks to play music, a song, or audio."
    )
    requires_approval = False
    risk_level = "low"
    built_in = True

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Search query for the music (song name, artist, genre, etc.).",
                        },
                    },
                    "required": ["query"],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        player = _get_player(args)
        if not player:
            return json.dumps({"error": "Media player not connected. Open the media player first."})

        query = args.get("query", "")

        if not query:
            return json.dumps({"error": "Query is required."})

        try:
            # Auto-enqueue if already playing
            enqueue = player.state == PlaybackState.PLAYING
            result = await player.play(query, enqueue=enqueue)
            return json.dumps({"result": result})
        except Exception as e:
            logger.error(f"play_music failed: {e}", exc_info=True)
            return json.dumps({"error": f"Failed to play music: {e}"})

    def describe_call(self, args: Dict[str, Any]) -> str:
        query = args.get("query", "?")
        return f"Play: {query}"


class MusicControlTool(BaseTool):
    """Control music playback: pause, resume, skip, stop."""

    name = "music_control"
    description = (
        "Control the music player. Actions: pause, resume, skip (next track), stop (end playback). "
        "Use when the user asks to pause, resume, skip, or stop music."
    )
    requires_approval = False
    risk_level = "low"
    built_in = True

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["pause", "resume", "skip", "stop"],
                            "description": "The playback control action to perform.",
                        },
                    },
                    "required": ["action"],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        player = _get_player(args)
        if not player:
            return json.dumps({"error": "Media player not connected. Open the media player first."})

        action = args.get("action", "")

        try:
            if action == "pause":
                await player.pause()
                return json.dumps({"result": "Paused."})
            elif action == "resume":
                await player.resume()
                return json.dumps({"result": "Resumed."})
            elif action == "skip":
                await player.skip()
                return json.dumps({"result": "Skipped to next track."})
            elif action == "stop":
                await player.stop()
                return json.dumps({"result": "Stopped playback."})
            else:
                return json.dumps({"error": f"Unknown action: {action}"})
        except Exception as e:
            logger.error(f"music_control failed: {e}", exc_info=True)
            return json.dumps({"error": f"Music control failed: {e}"})

    def describe_call(self, args: Dict[str, Any]) -> str:
        action = args.get("action", "?")
        return f"Music control: {action}"


class GetMusicQueueTool(BaseTool):
    """Get current music player state and queue."""

    name = "get_music_queue"
    description = (
        "Get the current music player state including what's playing, "
        "the queue of upcoming tracks, and volume level. "
        "Use when the user asks what's playing or about the music queue."
    )
    requires_approval = False
    risk_level = "low"
    built_in = True

    def get_schema(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": [],
                },
            },
        }

    async def execute(self, args: Dict[str, Any]) -> str:
        player = _get_player(args)
        if not player:
            return json.dumps({"error": "Media player not connected. Open the media player first."})

        return json.dumps(player.get_state(), ensure_ascii=False)

    def describe_call(self, args: Dict[str, Any]) -> str:
        return "Get music queue"
