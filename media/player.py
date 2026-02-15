"""Core media player with yt-dlp Python API and FFmpeg-cached streaming."""

import asyncio
import base64
import hashlib
import logging
import subprocess
from dataclasses import dataclass, field, asdict
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Coroutine, Dict, List, Optional

import yt_dlp

logger = logging.getLogger(__name__)

CHUNK_SIZE = 32 * 1024  # 32KB chunks
CACHE_DIR = Path("data/media_cache")
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Per-user player registry — shared between chat handler and LLM tools
_players: Dict[int, "MediaPlayer"] = {}


def get_media_player(user_id: int, send_event: Callable[..., Coroutine]) -> "MediaPlayer":
    """Get or create a MediaPlayer for a user, updating the send callback on reconnect."""
    if user_id in _players:
        _players[user_id]._send_event = send_event
        return _players[user_id]
    player = MediaPlayer(send_event)
    _players[user_id] = player
    return player


def remove_media_player(user_id: int) -> None:
    """Remove a user's MediaPlayer from the registry."""
    player = _players.pop(user_id, None)
    if player:
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(player.stop(send_state=False))
        except RuntimeError:
            pass


class PlaybackState(str, Enum):
    STOPPED = "stopped"
    PLAYING = "playing"
    PAUSED = "paused"


@dataclass
class Track:
    title: str
    url: str
    duration: Optional[float] = None
    thumbnail: Optional[str] = None
    artist: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def _cache_key(video_url: str) -> str:
    """Generate a cache filename from the video URL."""
    return hashlib.sha256(video_url.encode()).hexdigest()


def _get_cached(video_url: str) -> Optional[tuple[Path, str]]:
    """Return (path, format) if cached, else None."""
    key = _cache_key(video_url)
    for f in CACHE_DIR.glob(f"{key}.*"):
        fmt = f.suffix.lstrip(".")
        return f, fmt
    return None


def _search_ytdlp(query: str, max_results: int) -> List[Dict]:
    """Run yt-dlp extract_info in a thread-safe way (blocking)."""
    logger.debug(f"yt-dlp search starting: query={query!r}, max_results={max_results}")
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "default_search": f"ytsearch{max_results}",
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        result = ydl.extract_info(query, download=False)
        entries = result.get("entries", []) if result else []
        logger.debug(f"yt-dlp search done: {len(entries)} results")
        return entries


def _extract_audio_url(video_url: str) -> Optional[Dict]:
    """Extract best audio stream URL and metadata via yt-dlp (blocking, no download)."""
    logger.info(f"yt-dlp extracting audio URL: {video_url}")
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "format": "bestaudio/best",
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(video_url, download=False)
        logger.info(f"yt-dlp extracted: {info.get('title', '?')}, ext={info.get('ext', '?')}")
        return info


def _ffmpeg_download(audio_url: str, output_path: str) -> bool:
    """Download audio via FFmpeg with reconnect support (blocking)."""
    cmd = [
        "ffmpeg", "-y",
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "5",
        "-i", audio_url,
        "-c", "copy",
        output_path,
    ]
    logger.info(f"FFmpeg downloading to: {output_path}")
    result = subprocess.run(cmd, capture_output=True, timeout=300)
    if result.returncode != 0:
        logger.error(f"FFmpeg failed: {result.stderr.decode(errors='replace')[-500:]}")
        return False
    return True


class MediaPlayer:
    """Per-user stateful media player.

    Extracts audio URL via yt-dlp, downloads with FFmpeg (reconnect-safe),
    caches to disk, and streams base64 chunks through a callback.
    """

    def __init__(self, send_event: Callable[..., Coroutine]):
        self._send_event = send_event
        self._state = PlaybackState.STOPPED
        self._current_track: Optional[Track] = None
        self._queue: List[Track] = []
        self._volume: float = 1.0
        self._stream_task: Optional[asyncio.Task] = None
        self._pause_event = asyncio.Event()
        self._pause_event.set()  # Not paused initially

    @property
    def state(self) -> PlaybackState:
        return self._state

    async def search(self, query: str, max_results: int = 5) -> List[Track]:
        """Search YouTube via yt-dlp Python API and return track list."""
        entries = await asyncio.to_thread(_search_ytdlp, query, max_results)

        tracks = []
        for info in entries:
            if not info:
                continue
            tracks.append(Track(
                title=info.get("title", "Unknown"),
                url=info.get("url") or info.get("webpage_url") or info.get("original_url", ""),
                duration=info.get("duration"),
                thumbnail=info.get("thumbnail"),
                artist=info.get("uploader") or info.get("channel"),
            ))
        return tracks

    async def play(self, query: str, enqueue: bool = False) -> str:
        """Search and play or enqueue a track."""
        tracks = await self.search(query, max_results=1)
        if not tracks:
            return "No results found."

        track = tracks[0]

        if enqueue and self._state == PlaybackState.PLAYING:
            self._queue.append(track)
            await self._send_state()
            return f"Added to queue: {track.title}"

        # Stop current playback
        await self.stop(send_state=False)

        self._current_track = track
        self._state = PlaybackState.PLAYING
        self._pause_event.set()
        self._stream_task = asyncio.create_task(self._stream_track(track))
        await self._send_state()
        return f"Now playing: {track.title}"

    async def pause(self):
        """Pause current playback."""
        if self._state != PlaybackState.PLAYING:
            return
        self._state = PlaybackState.PAUSED
        self._pause_event.clear()
        await self._send_state()

    async def resume(self):
        """Resume paused playback."""
        if self._state != PlaybackState.PAUSED:
            return
        self._state = PlaybackState.PLAYING
        self._pause_event.set()
        await self._send_state()

    async def skip(self):
        """Skip to next track in queue."""
        if self._stream_task and not self._stream_task.done():
            self._stream_task.cancel()
            try:
                await self._stream_task
            except asyncio.CancelledError:
                pass
            self._stream_task = None

        if self._queue:
            track = self._queue.pop(0)
            self._current_track = track
            self._state = PlaybackState.PLAYING
            self._pause_event.set()
            self._stream_task = asyncio.create_task(self._stream_track(track))
            await self._send_state()
        else:
            self._state = PlaybackState.STOPPED
            self._current_track = None
            await self._send_state()

    async def stop(self, send_state: bool = True):
        """Stop playback and clear queue."""
        if self._stream_task and not self._stream_task.done():
            self._stream_task.cancel()
            try:
                await self._stream_task
            except asyncio.CancelledError:
                pass
            self._stream_task = None

        self._state = PlaybackState.STOPPED
        self._current_track = None
        self._queue.clear()
        self._pause_event.set()
        if send_state:
            await self._send_state()

    def set_volume(self, volume: float):
        """Set volume (0.0 to 1.0)."""
        self._volume = max(0.0, min(1.0, volume))

    async def add_to_queue(self, query: str) -> str:
        """Search and add a track to the queue."""
        tracks = await self.search(query, max_results=1)
        if not tracks:
            return "No results found."
        track = tracks[0]
        self._queue.append(track)
        await self._send_state()
        return f"Added to queue: {track.title}"

    def remove_from_queue(self, index: int) -> str:
        """Remove a track from the queue by index."""
        if 0 <= index < len(self._queue):
            removed = self._queue.pop(index)
            return f"Removed from queue: {removed.title}"
        return "Invalid queue index."

    def get_state(self) -> Dict[str, Any]:
        """Get current player state snapshot."""
        return {
            "state": self._state.value,
            "current_track": self._current_track.to_dict() if self._current_track else None,
            "queue": [t.to_dict() for t in self._queue],
            "volume": self._volume,
        }

    async def _send_state(self):
        """Send current state to client via callback."""
        from websocket.events import MediaStateEvent
        await self._send_event(MediaStateEvent(**self.get_state()))

    async def _send_error(self, error: str):
        """Send error to client via callback."""
        from websocket.events import MediaErrorEvent
        await self._send_event(MediaErrorEvent(error=error))

    async def _stream_track(self, track: Track):
        """Download to cache via FFmpeg (if needed), then stream chunks."""
        try:
            from websocket.events import MediaChunkEvent

            logger.info(f"Streaming: {track.title}")

            # Check cache first
            cached = _get_cached(track.url)
            if cached:
                cache_path, fmt = cached
                logger.info(f"Cache hit: {cache_path.name} ({cache_path.stat().st_size} bytes)")
            else:
                # Extract stream URL via yt-dlp (no download)
                info = await asyncio.to_thread(_extract_audio_url, track.url)
                if not info or not info.get("url"):
                    await self._send_error("Failed to extract audio URL.")
                    return

                audio_url = info["url"]
                ext = info.get("ext", "webm")
                fmt = ext

                # Download via FFmpeg (handles YouTube throttling/reconnects)
                key = _cache_key(track.url)
                cache_path = CACHE_DIR / f"{key}.{fmt}"
                success = await asyncio.to_thread(_ffmpeg_download, audio_url, str(cache_path))
                if not success or not cache_path.exists():
                    await self._send_error("Failed to download audio.")
                    return

                logger.info(f"Cached: {cache_path.name} ({cache_path.stat().st_size} bytes)")

            # Stream from cache file
            def _read_file_chunks():
                chunks = []
                with open(cache_path, "rb") as f:
                    while True:
                        data = f.read(CHUNK_SIZE)
                        if not data:
                            break
                        chunks.append(data)
                return chunks

            file_chunks = await asyncio.to_thread(_read_file_chunks)

            for i, raw in enumerate(file_chunks):
                await self._pause_event.wait()

                is_last = (i == len(file_chunks) - 1)
                encoded = base64.b64encode(raw).decode("ascii")
                await self._send_event(MediaChunkEvent(
                    data=encoded,
                    chunk_index=i,
                    is_last=is_last,
                    format=fmt,
                    sample_rate=48000,
                ))

            logger.info(f"Finished streaming: {track.title} ({len(file_chunks)} chunks)")

            # Auto-advance to next track
            if self._queue:
                next_track = self._queue.pop(0)
                self._current_track = next_track
                await self._send_state()
                await self._stream_track(next_track)
            else:
                self._state = PlaybackState.STOPPED
                self._current_track = None
                await self._send_state()

        except asyncio.CancelledError:
            logger.debug(f"Stream cancelled: {track.title}")
            raise
        except Exception as e:
            logger.error(f"Stream failed: {e}", exc_info=True)
            await self._send_error(f"Streaming error: {e}")
            self._state = PlaybackState.STOPPED
            self._current_track = None
            await self._send_state()
