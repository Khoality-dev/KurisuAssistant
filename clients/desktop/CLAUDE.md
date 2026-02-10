# CLAUDE.md

## Project Overview

KurisuAssistant-Client-Windows — desktop client for the KurisuAssistant AI platform. React + Electron + TypeScript + MUI + Framer Motion. Chat interface with streaming responses, TTS, image attachments, conversation management, and animated 2D character video call window.

## Tech Stack

React 18, Electron 28, MUI v5, Framer Motion, Zustand, Axios, Vite, react-markdown, TypeScript (strict mode)

## Commands

- Dev: `npm run electron:dev` (Vite on localhost:5173 + Electron)
- Build: `npm run electron:build` (tsc + Vite + electron-builder → `release/`)

## CI/CD

GitHub Actions workflow (`.github/workflows/build.yml`): triggers on release creation, builds NSIS installer on `windows-latest`, uploads `.exe` to the release via `softprops/action-gh-release@v2`.

## Architecture

```
electron/main.ts          — Multi-window Electron entry (main + character window)
electron/preload.ts       — contextBridge API (platform + characterWindow IPC bridge)
src/api/client.ts         — Axios + WebSocket singleton; streaming via wsManager
src/api/types.ts          — TypeScript interfaces for API
src/components/
  LoginWindow.tsx          — Login/Register tabs, Remember Me, Server URL field, purple gradient
  MainWindow.tsx           — Permanent sidebar (280px) + ChatWidget, conversation CRUD
  ChatWidget.tsx           — Chat UI with streaming, TTS auto-play, image attach, pagination, IPC bridge to character window
  MessageBubble.tsx        — Individual bubble: role styling, thinking collapse, TTS, resend/delete
  AgentsWindow.tsx         — Agent CRUD with tool assignment + character config button
  CharacterConfigDialog.tsx — React Flow graph editor: multi-pose nodes, edges with transition videos, conditions
  PoseNodeEditor.tsx        — Extracted 3-step stepper sub-dialog for editing individual pose nodes
  EdgeEditor.tsx            — Transition edge editor: video upload, condition config (random timer)
  PoseGraphNode.tsx         — Custom React Flow node component (thumbnail + label + default chip)
  SettingsWindow.tsx       — Account (backend) + TTS (localStorage) settings tabs
src/hooks/
  useTTS.ts               — TTS synthesis/playback: speak(), queueText(), clearQueue()
  useAudioAmplitude.ts    — Web Audio API amplitude for lip sync (AudioBufferSourceNode + time-domain RMS)
src/store/
  authStore.ts            — Auth state, login/register/logout, token persistence
  conversationStore.ts    — Conversations, messages (paginated 50/page), models
  agentStore.ts           — Agent list (filtered, no Administrator), selected agent ID (persisted)
src/CharacterWindowApp.tsx — Minimal IPC-driven renderer for separate character window (no auth/stores)
src/videocall/            — Character animation engine (rendered in separate Electron window via IPC)
  types.ts                — PoseConfig, PatchInfo, PoseTree, AnimationNode/Edge, TransitionCondition, AnimationSettings, CharacterConfig
  CharacterRenderer.tsx   — React wrapper around CanvasCompositor (accepts PoseTree, amplitude via ref)
  engine/
    CanvasCompositor.ts   — 60fps render: blink + breathing + mouth + pose tree state machine (idle→transitioning→idle), edge timers, video transitions, configurable AnimationSettings
    ImageCache.ts         — URL→HTMLImageElement cache
src/utils/storage.ts      — localStorage wrapper (auth token, model, TTS settings)
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

### Streaming TTS Auto-Play
- Accumulates content in buffer; on sentence boundary (`.!?。！？\n`), queues via `useTTS().queueText()`
- Parallel synthesis, sequential FIFO playback
- Flushes buffer on agent change or DoneEvent; `clearQueue()` on cancel/new send
- Tool messages excluded; voice reference tracked per-agent
- Action narration (`*walks over*`) stripped via `stripNarration()` before TTS — preserves `**bold**`

### Conversation Creation
- NOT explicit POST. Backend auto-creates on first `chatStream()` with `conversationId=null`
- First event returns `conversation_id`; `setCurrentConversationId()` refreshes sidebar if new

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
- `GET /conversations`, `GET /conversations/{id}`, `DELETE /conversations/{id}`, `POST /conversations/{id}` — Conversation CRUD
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

## Character Animation

Separate Electron window (toggleable via Face icon in top bar). Opens as independent, resizable BrowserWindow — same Vite bundle routed via `?window=character` query param → `CharacterWindowApp` (no auth, no stores, purely IPC-driven).

**IPC channels** (main renderer → main process → character renderer):
- `character:amplitude` — `{ amplitude, isPlaying }` at ~30fps via setInterval
- `character:agents-update` — `{ agents: [{id, name, poseTree}], activeAgentId }` on agent map or active agent change
- `character:window-closed` — main process → main renderer when user closes character window
- `character:open-window` / `character:close-window` — renderer invokes main process to create/destroy window

**Canvas compositing**: Base image + diff patches (eyes, mouth) at stored positions. Blink: configurable random interval state machine (default 2-6s). Breathing: sine wave vertical offset (configurable amplitude/period). Lip sync: audio amplitude → mouth patch index. Per-agent character configs stored in backend DB as JSON. **State machine**: IDLE (blink/breathing/mouth + event listening) → TRANSITIONING (playing edge video on canvas, all events ignored) → IDLE (switch to target pose, apply node settings, reset timers). During transitions no events are processed; random timers start fresh when arriving at a node. Edge conditions: `random` (timer-based), `thinking` (fires when `isThinking` matches `condition.value`). `isThinking` is a live variable observed each frame while idle — no edge detection. If multiple edges satisfy simultaneously, one is chosen at random. `isThinking` piggybacked on amplitude IPC channel at ~30fps. **Per-node animation settings**: `AnimationNode.animation_settings` (optional) configures breathing (enabled/amplitude/period) and blink timing (min/max interval, close/hold/open duration). Applied via `applySettings()` on each pose switch. UI: sliders in PoseNodeEditor Preview step. **Per-edge playback rate**: `AnimationEdge.playback_rate` (optional, default 1.0) controls transition video speed. UI: slider in EdgeEditor.

**Asset pipeline**: AI-generated base → inpainted variants → backend OpenCV diff → cropped patch PNGs. Assets stored in folder structure: `data/character_assets/{agent_id}/{pose_id}/base.png`, `{part}_{index}.png`; videos in `{agent_id}/edges/{edge_id}.mp4|.webm`. Re-uploading overwrites without changing URLs. Orphaned assets cleaned up on config save.

**Data flow**: ChatWidget fetches agent character_config on agent switch during streaming → builds agentMap (with poseTree, not poseConfig) + activeAgentId → sends via IPC to character window. TTS amplitude ref read by setInterval(33ms) and sent via IPC. CharacterWindowApp receives IPC data and renders CharacterRenderer components. CharacterRenderer calls `compositor.loadPoseTree()` to load all poses + initialize edge timers. CanvasCompositor reads amplitude at 60fps from local ref.

**Graph editor (CharacterConfigDialog)**: React Flow (@xyflow/react) canvas with custom `poseNode` nodes. Nodes represent poses; edges represent transitions with optional video clips and conditions. Sub-dialogs: PoseNodeEditor (3-step stepper for base/patches/preview), EdgeEditor (video upload + condition config). Right-click node for context menu (Set as Default, Edit, Delete). Conversion: poseTreeToReactFlow/reactFlowToPoseTree.

## Storage Keys (localStorage)

`kurisu_auth_token`, `kurisu_remember_me`, `kurisu_selected_model`, `kurisu_backend_url`, `kurisu_tts_backend`, `kurisu_tts_voice`, `kurisu_tts_language`, `kurisu_tts_auto_play`, `kurisu_tts_emo_audio`, `kurisu_tts_emo_alpha`, `kurisu_tts_use_emo_text`, `kurisu_selected_agent_id`

## Security

- contextIsolation enabled, nodeIntegration disabled
- Token validated on startup (not blindly trusted)
- Tokens in localStorage (renderer-only, no XSS risk with contextIsolation)
