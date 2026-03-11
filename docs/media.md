# Media Player (yt-dlp Audio Streaming)

## Architecture

LLM tool calls and WebSocket events both access the same `MediaPlayer` instance via a per-user registry (`get_media_player(user_id, send_event)` in `media/player.py`). All media events (control + audio chunks) flow through the main `/ws/chat` WebSocket.

## Player Registry

Module-level `_players` dict keyed by `user_id`. `get_media_player()` creates or returns existing player, updating `send_event` callback on WebSocket reconnect. Shared between chat handler and LLM tools (via `tools/media.py`).

## Playback

- **Controls**: play, pause (asyncio.Event-based), resume, skip, stop, volume, queue management
- **Search**: yt-dlp Python API (`ytsearch`, `skip_download=True`) returns track metadata (title, URL, duration, thumbnail, artist)
- **Streaming**: aiohttp downloads audio directly from CDN URL (extracted via yt-dlp), streams 32KB base64 chunks via WebSocket. Auto-advances queue on track completion.

## WebSocket Events

### Client → Server
- `MEDIA_PLAY(query)` — search and play a track
- `MEDIA_PAUSE` — pause playback
- `MEDIA_RESUME` — resume playback
- `MEDIA_SKIP` — skip to next track
- `MEDIA_STOP` — stop playback and clear queue
- `MEDIA_QUEUE_ADD(query)` — add track to queue
- `MEDIA_QUEUE_REMOVE(index)` — remove track from queue
- `MEDIA_VOLUME(volume)` — set volume level

### Server → Client
- `MEDIA_STATE(state, current_track, queue, volume)` — full player state update
- `MEDIA_CHUNK(data, chunk_index, is_last, format, sample_rate)` — audio data chunk
- `MEDIA_ERROR(error)` — error notification

## Dependencies

- `yt-dlp` (pip)
- `aiohttp` (pip)
