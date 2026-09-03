# WebSocket Protocol

## Connection

**Single WebSocket** (`/ws/chat`): All communication (chat, vision) flows through one WebSocket connection.

## Reconnection

Messages are persisted to DB incrementally (each complete message saved on role boundary). No server-side replay needed. `replace_websocket()` swaps socket + cancels old heartbeat.

On every connect/reconnect, server sends `ConnectedEvent` with full state snapshot:
- `chat_active`, `conversation_id`, `frame_id`
- `vision_active`, `vision_config`

Client loads already-persisted messages from DB on reconnect, enters streaming mode if task still active, and receives remaining chunks live. Client stores use ConnectedEvent to sync: ChatWidget loads conversation + resumes streaming, visionStore re-sends vision_start if server lost state.

## Heartbeat

Server pings client every 30s; client responds with pong. If no pong within 10s, server closes the connection. Client auto-reconnects with exponential backoff.

## Outgoing Message Queue

When WebSocket is disconnected, outgoing messages (except `vision_frame`) are queued and flushed on reconnect.

## Connection Status UI

`useConnectionStatus` hook subscribes to `wsManager.onStatusChange()`. Green/amber/red dot in MainWindow top bar.

## Event Types

### Chat Events (server→client)
- `StreamChunkEvent` — streaming content with `conversation_id`, `frame_id`, optional `images` (list of UUIDs)
- `DoneEvent` — end of response
- `TurnUpdateEvent` — orchestration turn updates
- `LLMLogEvent` — LLM call logging
- `AgentSwitchEvent` — agent routing changes
- `ConnectedEvent` — full state snapshot on connect/reconnect

### Vision Events
- **Client→Server**: `VisionStartEvent` (enable_face/enable_pose/enable_hands flags), `VisionFrameEvent` (base64 JPEG), `VisionStopEvent`
- **Server→Client**: `VisionResultEvent` (faces + gestures metadata only)

### MCP Client Tool Events
- **Server→Client**: `tool_call_request` — forwarded tool call to Electron client
- **Client→Server**: `tool_call_response` — result from client-side MCP execution (120s timeout)
- **Client→Server**: `client_tools_register` — register client-side MCP tool schemas
