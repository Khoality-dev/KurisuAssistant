# CLAUDE.md

## Project Overview

KurisuAssistant-Client-Windows — desktop client for the KurisuAssistant AI platform. React + Electron + TypeScript + MUI + Framer Motion. Chat interface with streaming responses, TTS, image attachments, conversation management, and animated 2D character video call window.

## Tech Stack

React 18, Electron 28, MUI v5, Framer Motion, Zustand, Axios, Vite, react-markdown, electron-updater, TypeScript (strict mode)

## Commands

- Dev: `npm run electron:dev` (Vite on localhost:5173 + Electron)
- Build: `npm run electron:build` (tsc + Vite + electron-builder → `release/`)

## CI/CD

GitHub Actions workflow (`.github/workflows/build.yml`): triggers on release creation, sets `package.json` version from release tag (strips `v` prefix), builds NSIS installer on `windows-latest`, publishes `.exe` + `latest.yml` to the release via `electron-builder --publish always` (uses `GH_TOKEN`). Auto-update: `electron-updater` checks GitHub Releases on app startup, downloads updates in background, prompts user to restart via `UpdateDialog`.

## Architecture

```
electron/main.ts          — Multi-window Electron entry (main + character window) + auto-updater setup
electron/preload.ts       — contextBridge API (platform + updater + characterWindow IPC bridge)
src/api/client.ts         — Axios + WebSocket singleton; streaming + media via wsManager; migrateCharacterIds()
src/api/types.ts          — TypeScript interfaces for API
src/components/
  LoginWindow.tsx          — Login/Register tabs, Remember Me, Server URL field, purple gradient
  MainWindow.tsx           — Top bar (tabs + agent selector + clear conversation) + ChatWidget, no sidebar
  ChatWidget.tsx           — Chat UI with streaming, TTS auto-play, image attach, pagination, IPC bridge to character window, voice interaction mode
  MessageBubble.tsx        — Individual bubble: role styling, thinking collapse, TTS, resend/delete
  ToolsWindow.tsx          — Three tabs: MCP Servers, Available Tools, Skills (CRUD + import/export)
  AgentsWindow.tsx         — Agent CRUD with tool assignment + character config button
  FacesWindow.tsx          — Face identity CRUD, webcam vision controls, live recognition display
  MediaPlayerBar.tsx       — Bottom bar: track info, play/pause/skip/stop, volume slider, slide-up animation. Visible when media playing/buffering.
  CharacterConfigDialog.tsx — React Flow graph editor: multi-pose nodes, edges with transition videos, conditions
  PoseNodeEditor.tsx        — Extracted 3-step stepper sub-dialog for editing individual pose nodes
  EdgeEditor.tsx            — Transition edge editor: video upload, condition config (random timer)
  PoseGraphNode.tsx         — Custom React Flow node component (thumbnail + label + default chip)
  UpdateDialog.tsx          — Auto-update notification: shows download progress, "Restart Now" / "Later" on completion
  SettingsWindow.tsx       — Account (backend) + TTS (localStorage) settings tabs
src/hooks/
  useTTS.ts               — TTS synthesis/playback: speak(), queueText(), clearQueue(), onPlaybackStart subtitle callback, WAV duration parsing
  useAudioAmplitude.ts    — Web Audio API amplitude for lip sync (AudioBufferSourceNode + time-domain RMS)
src/store/
  authStore.ts            — Auth state, login/register/logout, token persistence
  conversationStore.ts    — Current conversation + messages (paginated 20/page). No conversation list — agent selection drives conversation via localStorage mapping.
  agentStore.ts           — Agent list (filtered, no Administrator), selected agent ID (persisted). Agent selection triggers conversation load via agent-conversation mapping.
  visionStore.ts          — Zustand singleton: vision pipeline control (getUserMedia webcam capture, frame upload at 3 FPS via WebSocket, face/pose/hands toggles, WebSocket vision_result listener + gesture IPC forwarding). Used by both FacesWindow and ChatWidget camera toggle.
  mediaStore.ts           — Zustand singleton: media player state (playback, track, queue, volume). All media events (control + chunks) flow through wsManager on /ws/chat. Module-level listeners for media_state/media_chunk/media_error. Buffers base64 chunks → Blob → Audio playback. Volume persisted to localStorage.
src/CharacterWindowApp.tsx — Minimal IPC-driven renderer for separate character window (no auth/stores, subtitle overlay)
src/videocall/            — Character animation engine (rendered in separate Electron window via IPC)
  types.ts                — PoseConfig, PatchInfo, PoseTree, AnimationNode/Edge/EdgeTransition, TransitionCondition (random/thinking/gesture), AnimationSettings, CharacterConfig, migrateEdgeToTransitions(), migratePoseTreeIds() (old pose-*/edge-* IDs → 8-char hex)
  CharacterRenderer.tsx   — React wrapper around CanvasCompositor (accepts PoseTree, amplitude via ref)
  engine/
    CanvasCompositor.ts   — 60fps render: blink + breathing + mouth + pose tree state machine (idle→transitioning→idle), edge timers, video transitions, configurable AnimationSettings
    ImageCache.ts         — URL→HTMLImageElement cache
src/utils/storage.ts      — localStorage wrapper (auth token, model, TTS settings, agent-conversation mapping)
src/theme/theme.ts        — MUI theme: primary #10A37F, 8px/12px border-radius
src/config.ts             — API URL config (reads dynamically from storage)
```

## Code Style

- Functional components + hooks only
- Zustand for global state, useState for local
- MUI `sx` prop for styling (no CSS files)
- Framer Motion for animations
- Try/catch + MUI Alert for errors
- PascalCase components, camelCase stores

## Key Patterns

### Streaming Architecture (ChatWidget)
- **Store `messages`** = DB-persisted only (never mutated during streaming)
- **`streamingMessages`** = ephemeral local state (user msg + agent responses during stream)
- Render: `[...messages, ...streamingMessages]`
- Uses WebSocket via `wsManager` (StreamChunkEvent, DoneEvent, ErrorEvent)
- Same-role chunks accumulated into single bubble; role/agent change → new bubble
- Display via `requestAnimationFrame` batching
- On DoneEvent: `loadConversation()` refreshes store from DB, clears streamingMessages
- Typing indicator: bouncing dots inside bubble before first chunk; "Done" checkmark after

### Streaming TTS (Always On)
- TTS always active (no toggle). Accumulates content in buffer; on sentence boundary (`.!?。！？\n`), queues via `useTTS().queueText()`
- Parallel synthesis, sequential FIFO playback
- Flushes buffer on agent change or DoneEvent; `clearQueue()` on cancel/new send
- Tool messages excluded; voice reference tracked per-agent
- Action narration (`*walks over*`) stripped via `stripNarration()` before TTS — preserves `**bold**`
- **Subtitles**: `useTTS` parses WAV header for duration, calls `onPlaybackStart(text, duration)` before each queue item plays. On TTS error, falls back to 4s duration. ChatWidget forwards to character window via IPC.

### Voice Interaction Mode (Trigger Word)
- Per-agent `trigger_word` (nullable string) enables hands-free voice conversation
- **Flow**: Mic on → ASR transcript contains trigger word (case-insensitive) → enter interaction mode → auto-send full transcript → agent responds with TTS → 30s idle timer after TTS finishes → exit mode
- While in interaction mode, all subsequent ASR transcripts auto-send without needing trigger word
- ASR transcripts without trigger word match are ignored (not inserted into input field)
- If user speaks while agent is still streaming, transcript stored in `pendingAutoSendRef` and sent when streaming completes
- **Exit conditions**: 30s silence after TTS+streaming finish, mic turned off (`asrStatus === 'idle'`), agent change, conversation change
- **State**: `isInteractionMode` (boolean), `interactionTimerRef` (30s timeout), `pendingAutoSendRef` (queued transcript)
- **Visual**: Green "Voice Active" chip next to mic button; mic icon turns green in interaction mode
- **Sound effects**: `public/start_effect.wav` plays on mode enter, `public/stop_effect.wav` on mode exit
- **Config**: `Agent.trigger_word` field in AgentsWindow edit dialog, stored in backend DB

### Conversation Management (One Per Agent)
- No conversation sidebar — each agent has one conversation, managed via `kurisu_agent_conversations` localStorage mapping (`Record<string, number>`, agent ID → conversation ID)
- Agent selection triggers conversation load (or empty state if no mapping exists)
- **Fallback recovery**: When localStorage mapping is missing (cleared, new device, etc.), agent store queries `GET /conversations?agent_id=` to find the latest conversation with messages from that agent. If found, loads it and restores the localStorage mapping. If not found, shows empty state (conversation auto-created on first message).
- Backend auto-creates conversation on first message with `conversationId=null`; first `StreamChunkEvent` saves the mapping
- "Clear conversation" button deletes via API + removes mapping entry
- Mapping cleared on logout (`clearAllAgentConversations`) and agent delete (`clearAgentConversationId`)

### Auth Flow
- Login → POST /login → JWT token → stored in apiClient + localStorage (if rememberMe)
- App startup: `initializeAuth()` → validates saved token via GET /users/me

### Image Handling
- Upload: POST /images → {image_uuid} → sent with chat FormData
- Display: user images at top of bubble; assistant images via markdown `![Image](/images/uuid)`

### Pagination
- 50 messages/page, newest first. Scroll to top triggers `loadMoreMessages()`. Position preserved.

## Backend API Endpoints

- `POST /login`, `POST /register` — Auth, returns JWT
- `GET /conversations` (?agent_id= for latest by agent), `GET /conversations/{id}`, `DELETE /conversations/{id}`, `POST /conversations/{id}` — Conversation CRUD
- `POST /chat` — WebSocket-based streaming chat (FormData: text, model_name, conversation_id?, images?)
- `GET /models` — Available LLM models (`{models: string[]}`)
- `GET /users/me`, `PUT /users/me` — User profile
- `GET /images/{uuid}`, `POST /images` — Image upload/fetch
- `POST /tts`, `GET /tts/voices`, `GET /tts/backends` — TTS synthesis and voice listing
- `GET /agents`, `POST /agents`, `PATCH /agents/{id}`, `DELETE /agents/{id}` — Agent CRUD
- `GET /tools` — Available tools for agent assignment
- `POST /character-assets/upload-base?agent_id=&pose_id=` — Upload base portrait → `{agent_id}/{pose_id}/base.png`
- `POST /character-assets/compute-patch?agent_id=&pose_id=&part=&index=` — Upload keyframe, backend diffs → `{agent_id}/{pose_id}/{part}_{index}.png`
- `POST /character-assets/upload-video?agent_id=&edge_id=` — Upload transition video → `{agent_id}/edges/{edge_id}.mp4|.webm`
- `GET /character-assets/{agent_id}/{pose_id}/{filename}` — Serve pose asset (base/patch image, no-cache)
- `GET /character-assets/{agent_id}/edges/{edge_id}` — Serve transition video (no-cache)
- `PATCH /character-assets/{agent_id}/character-config` — Update pose tree config (cleans up orphaned assets incl. videos)
- `POST /character-assets/{agent_id}/migrate-ids` — Rename asset files/folders on disk to match migrated IDs
- `GET /faces`, `POST /faces`, `GET /faces/{id}`, `DELETE /faces/{id}` — Face identity CRUD
- `POST /faces/{id}/photos`, `DELETE /faces/{id}/photos/{photo_id}` — Face photo management
- `GET /faces/{id}/photos/{photo_id}/image` — Serve face photo image
- `GET /skills`, `POST /skills`, `PATCH /skills/{id}`, `DELETE /skills/{id}` — Skill CRUD (user-editable instruction blocks)

## Character Animation

Separate Electron window (toggleable via Face icon in top bar). Opens as independent, resizable BrowserWindow — same Vite bundle routed via `?window=character` query param → `CharacterWindowApp` (no auth, no stores, purely IPC-driven).

**IPC channels** (main renderer → main process → character renderer):
- `character:amplitude` — `{ amplitude, isPlaying, isThinking }` at ~30fps via setInterval
- `character:agents-update` — `{ agents: [{id, name, poseTree}], activeAgentId }` on agent map or active agent change
- `character:gesture-update` — `{ gestures: string[] }` forwarded from vision pipeline to trigger pose transitions
- `character:subtitle` — `{ text: string, isUser: boolean, duration?: number }` subtitles displayed as overlay at bottom of character window. Agent text: `sentenceDuration = chunkDuration / sentenceCount` (chunk split on `.!?。！？\n`). TTS success → chunkDuration = WAV duration; TTS error → chunkDuration = 4s. Sentences queued and shown sequentially, chaining immediately, fade only after last. User text shown immediately with word-count-based hold. Empty text clears (cancel).
- `character:window-closed` — main process → main renderer when user closes character window
- `character:open-window` / `character:close-window` — renderer invokes main process to create/destroy window

**Canvas compositing**: Base image + diff patches (eyes, mouth) at stored positions. Blink: configurable random interval state machine (default 2-6s). Breathing: sine wave vertical offset (configurable amplitude/period). Lip sync: audio amplitude → mouth patch index. Per-agent character configs stored in backend DB as JSON. **State machine**: IDLE (blink/breathing/mouth + event listening) → TRANSITIONING (playing edge video on canvas, all events ignored) → IDLE (switch to target pose, apply node settings, reset timers). During transitions no events are processed; random timers start fresh when arriving at a node. **Multi-transition edges**: Each directed edge (`AnimationEdge`) contains `transitions: EdgeTransition[]` — multiple transitions per edge, each with its own condition, video list, and playback rate. One edge per directed node pair (ID: `{source}-{target}`). Timer keys use `${edge.id}:${transitionIndex}`. Legacy edges (single condition/video_urls/playback_rate) auto-migrated on load via `migrateEdgeToTransitions()`. Legacy IDs (`pose-*`/`edge-*`) auto-migrated to 8-char random hex via `migratePoseTreeIds()` (calls `POST /character-assets/{agent_id}/migrate-ids` to rename files on disk). Bidirectional edges render side-by-side with perpendicular offset (not overlapping). Transition conditions: `random` (timer-based), `thinking` (fires when `isThinking` matches `condition.value`), `gesture` (fires when detected gesture matches `condition.value`, e.g. "wave", "thumbs_up", "peace_sign"). `isThinking` is a live variable observed each frame while idle — no edge detection. If multiple transitions satisfy simultaneously, one is chosen at random. `isThinking` piggybacked on amplitude IPC channel at ~30fps. **Per-node animation settings**: `AnimationNode.animation_settings` (optional) configures breathing (enabled/amplitude/period) and blink timing (min/max interval, close/hold/open duration). Applied via `applySettings()` on each pose switch. UI: sliders in PoseNodeEditor Preview step.

**Asset pipeline**: AI-generated base → inpainted variants → backend OpenCV diff → cropped patch PNGs. Assets stored in folder structure: `data/character_assets/{agent_id}/{pose_id}/base.png`, `{part}_{index}.png`; videos in `{agent_id}/edges/{edge_id}.mp4|.webm`. Re-uploading overwrites without changing URLs. Orphaned assets cleaned up on config save.

**Data flow**: ChatWidget fetches agent character_config on agent switch during streaming → builds agentMap (with poseTree, not poseConfig) + activeAgentId → sends via IPC to character window. TTS amplitude ref read by setInterval(33ms) and sent via IPC. CharacterWindowApp receives IPC data and renders CharacterRenderer components. CharacterRenderer calls `compositor.loadPoseTree()` to load all poses + initialize edge timers. CanvasCompositor reads amplitude at 60fps from local ref.

**Graph editor (CharacterConfigDialog)**: React Flow (@xyflow/react) canvas with custom `poseNode` nodes. Nodes represent poses; one edge per directed node pair containing multiple transitions. Connecting an existing pair opens the edge editor instead of creating a duplicate. Sub-dialogs: PoseNodeEditor (3-step stepper for base/patches/preview), EdgeEditor (multi-transition cards with per-transition condition/video/playback rate). Right-click node for context menu (Toggle Default, Edit, Delete). Multiple nodes can be marked as default (`default_pose_ids: string[]`); one chosen randomly at runtime. Conversion: poseTreeToReactFlow/reactFlowToPoseTree. Video upload naming: `${edge.id}_t${transitionIdx}_${videoIdx}`.

## Storage Keys (localStorage)

`kurisu_auth_token`, `kurisu_remember_me`, `kurisu_selected_model`, `kurisu_backend_url`, `kurisu_tts_backend`, `kurisu_tts_voice`, `kurisu_tts_language`, `kurisu_tts_emo_audio`, `kurisu_tts_emo_alpha`, `kurisu_tts_use_emo_text`, `kurisu_selected_agent_id`, `kurisu_agent_conversations`, `kurisu_media_volume`

## Security

- contextIsolation enabled, nodeIntegration disabled
- Token validated on startup (not blindly trusted)
- Tokens in localStorage (renderer-only, no XSS risk with contextIsolation)
