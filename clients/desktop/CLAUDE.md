# CLAUDE.md

## Project Overview

`clients/desktop/` in the KurisuAssistant monorepo (see the root `CLAUDE.md`; the backend is in `../../backend/`) — cross-platform desktop client (Windows + Linux) for the KurisuAssistant AI platform. React + Electron + TypeScript + MUI + Framer Motion. Chat interface with streaming responses, TTS, image attachments, conversation management, and animated 2D character video call window.

## Tech Stack

React 18, Electron 28, MUI v5, Framer Motion, Zustand, Axios, Vite, react-markdown, electron-updater, @modelcontextprotocol/sdk, TypeScript (strict mode)

## Commands

- Dev: `npm run electron:dev` (Vite on localhost:5173 + Electron)
- Build: `npm run electron:build` (tsc + Vite + electron-builder → `release/`)
- E2E tests: `npm run test:e2e:build` then `npm run test:e2e` (Playwright Electron; see `tests/`)

## CI/CD

Workflows live at the repo root. `.github/workflows/desktop-build.yml` triggers on tags `desktop-vX.Y.Z`, sets `package.json` version from the tag, builds the NSIS installer on `windows-latest` and AppImage + deb on `ubuntu-latest`, and publishes them with `latest.yml` / `latest-linux.yml` as release `vX.Y.Z` on the legacy `Khoality-dev/KurisuAssistant-Client-Desktop` repo via `electron-builder --publish always` (`GH_TOKEN` = `CLIENT_RELEASE_TOKEN` secret, a PAT with write access to that repo). Keep `build.publish.repo` in `package.json` pointing there: installed apps' `electron-updater` reads that repo's latest release. `.github/workflows/desktop-test.yml` runs the Playwright suite on pushes/PRs that touch `clients/desktop/`. Auto-update: `electron-updater` checks GitHub Releases on app startup, downloads updates in background, prompts user to restart via `UpdateDialog`.

## Architecture

```
electron/main.ts          — Multi-window Electron entry + auto-updater + single instance lock + IPC registration (MCP, host tools, app tools, explorer)
electron/mcp.ts           — MCP server manager: start/stop stdio/SSE servers, tool discovery/execution. IPC: mcp:start-server(s), mcp:stop-servers, mcp:list-tools, mcp:call-tool, mcp:is-server-running
electron/hostTools.ts     — Agent host tools (sandboxed to per-agent allowed_paths): host_read/write/edit/search/bash. Settings persistence for allowed paths.
electron/appTools.ts      — App config tools for agents: agent CRUD, MCP server management, vision control, browser launch (CDP). Forwards to renderer via IPC round-trip.
electron/explorerIPC.ts   — Unsandboxed file explorer IPC: list-directory, read-file, write-file, is-binary, has-vscode, open-in-vscode
electron/preload.ts       — contextBridge: hostTools, appTools, explorer, mcp, characterWindow, extensions, updater
src/api/client.ts         — Axios + WebSocket singleton; streaming + media via wsManager; migrateCharacterIds()
src/api/types.ts          — TypeScript interfaces for API
src/components/
  layout/
    MainLayout.tsx         — 3-panel layout: ActivityBar (52px) | MainContent (flex) | ResizeHandle | ChatPanel (resizable)
    ActivityBar.tsx        — Narrow icon column: Workspace/Conversations/Settings nav + connection/character/call/logout
    ChatPanel.tsx          — Persistent right panel: agent header + ChatWidget
    ResizeHandle.tsx       — DOM-based drag resize (no React re-renders during drag, sync on mouseup)
  explorer/
    FileExplorerPage.tsx   — Workspace page: FullExplorer (no files open) or FileTreeSidebar + EditorTabs + FileEditor
    FullExplorer.tsx       — Full-page file browser: breadcrumb, list/grid views, multi-select (Ctrl/Shift/lasso). Uses useFileOperations hook, ExplorerContextMenus, ExplorerDialogs.
    ExplorerContextMenus.tsx — File context menu (rename/copy/cut/delete/open/add-to-chat) + background context menu (new file/folder/paste/open in VS Code)
    ExplorerDialogs.tsx    — Rename dialog + New File/Folder dialog
    FileTreeSidebar.tsx    — Editor-mode tree: shows workspaceRoot folder, lazy-load children, resizable, right-click Open Folder/Add to Chat
    EditorTabs.tsx         — Tab bar: file icon + name, dirty dot, middle-click/X close, right-click Add to Chat, tooltip with full path
    FileEditor.tsx         — Monaco editor: Ctrl+S save, auto-detect language, binary detection with Open Anyway, image preview, selection→chat context
    FileIcon.tsx           — Custom SVG icons by type (folder, TS, JS, PY, JSON, MD, HTML, CSS, image, config, default)
  conversations/
    ConversationsPage.tsx  — Agent list with search, avatar, last message preview, timestamps. Click loads conversation into ChatPanel.
  settings/
    SettingsPage.tsx       — Left nav sidebar (10 sections) + lazy-loaded content area
    AccountSection.tsx     — Ollama URL, summary model, context size
    TTSSection.tsx         — TTS backend, auto-play, voice, emotion controls, ASR language
    AppearanceSection.tsx  — Light/dark theme toggle
    AgentsSection.tsx      — Agent CRUD with dialogs for role/capability (name, system_prompt, model, tools, memory) plus the identity fields: avatar, voice, character config, preferred name, trigger word. Personas were merged into agents; there is no separate persona surface.
    MCPServersSection.tsx  — Local servers detection (Maestro, Chronicle, Playwright) + user MCP server CRUD
    ToolsSection.tsx       — Available tools list with details dialog
    SkillsSection.tsx      — Skill CRUD + import/export
    HostAccessSection.tsx  — Per-agent allowed paths config
    FacesSection.tsx       — Face identity CRUD, detail/delete dialogs, vision preview
    FaceCreateDialog.tsx   — Face registration dialog: webcam capture, photo grid, name input. Uses useWebcamCapture hook.
    ExtensionsSection.tsx  — Companion app installer (Maestro, Chronicle)
  LoginWindow.tsx          — Login/Register tabs, Remember Me, Server URL field
  MessageBubble.tsx        — Re-exports from chat/ subfolder
  InteractiveCallBar.tsx   — Voice mode call bar: transcript, mic button with pulse, hang up
  chat/
    ChatWidget.tsx         — Chat UI with streaming, TTS, image attach, pagination, voice mode, selection context chips, display mode toggle (All/Context), token usage bar
    ChatComposer.tsx       — Message input composer with file attach, voice input, slash command autocomplete, prompt history (up/down arrows)
    SelectionChips.tsx     — File selection context chips
    MessageBubble.tsx      — Individual bubble: role styling, thinking collapse, TTS, resend/delete
    MessageToolbar.tsx     — Hover toolbar: copy, TTS play, raw data, resend/regenerate, delete
    RawDataDialog.tsx      — Dialog showing raw LLM input/output JSON (self-contained fetch)
  CharacterConfigDialog.tsx — Re-exports from character/ subfolder
  character/
    CharacterConfigDialog.tsx — React Flow graph editor: multi-pose nodes, edges with transition videos
    graphHelpers.ts         — Pure helpers: poseTreeToReactFlow, reactFlowToPoseTree, getEdgeVisuals, getBestHandles, nextNodeId
    OffsetEdge.tsx          — Custom React Flow edge component (straight, bidirectional offset, self-loop)
    PreviewCanvas.tsx       — Self-contained canvas preview with CanvasCompositor (mouth/eye/breathing animations)
    PoseNodeEditor.tsx      — 3-step stepper for pose node editing (base image, keyframes, preview)
  PoseNodeEditor.tsx       — Re-exports from character/ subfolder
  EdgeEditor.tsx           — Transition edge editor: video upload, condition config
  PoseGraphNode.tsx        — Custom React Flow node component
  UpdateDialog.tsx         — Auto-update notification
src/hooks/
  useTTS.ts               — TTS synthesis/playback: speak(), queueText(), clearQueue(), onPlaybackStart subtitle callback, WAV duration parsing
  useAudioAmplitude.ts    — Web Audio API amplitude for lip sync (AudioBufferSourceNode + time-domain RMS)
  useConnectionStatus.ts  — Hook subscribing to wsManager.onStatusChange() for connection status (connected/connecting/disconnected)
  useWebcamCapture.ts    — Webcam stream management: startWebcam(), stopWebcam(), captureFrame() → CapturedPhoto (File + preview). Refs for video/canvas elements. Cleanup on unmount.
  useFileOperations.ts   — File operation hook for explorer: clipboard (cut/copy), rename, create file/folder, delete, paste + keyboard shortcuts (Ctrl+C/X/V/A, F2, F3, Delete)
src/store/
  authStore.ts            — Auth state, login/register/logout, token persistence
  conversationStore.ts    — Current conversation + messages (paginated 20/page). No conversation list — agent selection drives conversation via localStorage mapping.
  agentStore.ts           — Agent list (filtered, no Administrator), selected agent ID (persisted), agent previews (last message per agent for sidebar). Agent selection triggers conversation load via agent-conversation mapping.
  layoutStore.ts          — Layout state: activePage (workspace/conversations/settings), chatPanelWidth, workspaceTreeWidth, settingsSection (persisted)
  explorerStore.ts        — File explorer: tree navigation, open/close/save files, dirty detection, selections for chat context, view mode, lasso multi-select
  visionStore.ts          — Zustand singleton: vision pipeline control (getUserMedia webcam capture, backpressure-based frame upload via WebSocket with max 5 in-flight frames, face/pose/hands toggles, WebSocket vision_result listener + gesture IPC forwarding). Syncs state on reconnect via `connected` listener. Used by both FacesWindow and ChatWidget camera toggle.
  micStore.ts             — Zustand singleton: ASR lifecycle (VAD, status, result, devices) + interactive mode with substates. Module-level VAD instance, lazy-init reusable Audio elements for sound effects. Two-level state: `interactiveMode` (call bar UI shown, mic auto-started) + `interactionActive` (auto-send without trigger word). Used by MainWindow (phone toggle) and ChatWidget (transcript handling, conditional render).
src/services/
  mcpService.ts            — Client-side MCP lifecycle: auto-init on WebSocket connect, fetches client-location MCP configs from API, starts local servers via Electron IPC, discovers tools, registers schemas with backend via client_tools_register event. Handles tool_call_request forwarding (execute locally → send tool_call_response). refreshClientMCPServers() for config changes.
src/CharacterWindowApp.tsx — Minimal IPC-driven renderer for separate character window (no auth/stores, subtitle overlay)
src/videocall/            — Character animation engine (rendered in separate Electron window via IPC)
  types.ts                — PoseConfig, PatchInfo, PoseTree, AnimationNode/Edge/EdgeTransition, TransitionCondition (random/thinking/gesture), AnimationSettings, CharacterConfig, migrateEdgeToTransitions(), migratePoseTreeIds() (old pose-*/edge-* IDs → 8-char hex)
  CharacterRenderer.tsx   — React wrapper around CanvasCompositor (accepts PoseTree, amplitude via ref)
  engine/
    CanvasCompositor.ts   — 60fps render: blink + breathing + mouth + pose tree state machine (idle→transitioning→idle), edge timers, video transitions, configurable AnimationSettings
    ImageCache.ts         — URL→HTMLImageElement cache
src/utils/storage.ts      — localStorage wrapper (auth token, model, TTS settings, agent-conversation mapping)
src/utils/commands.ts     — Slash command system: /compact, /clear. Autocomplete via getCommands(). Async handleCommand() with feedback strings. Lazy imports to avoid circular deps.
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
- Render: `[...displayedMessages, ...streamingMessages]` where `displayedMessages` is filtered by display mode
- Uses WebSocket via `wsManager` (StreamChunkEvent, DoneEvent, ErrorEvent, ContextInfoEvent)
- Same-role chunks accumulated into single bubble; role/agent change → new bubble
- Display via `requestAnimationFrame` batching
- On DoneEvent: streaming messages merged into store instantly (no flash), background `loadConversation()` after 500ms for DB IDs/metadata
- On Cancel: streaming messages merged into store, late chunks ignored via `cancelledRef`
- **Message queue**: Users can send messages during streaming. Frontend shows queued user bubbles immediately; backend queues the request and processes it after current response finishes. Cancel clears the queue.
- **Reconnect**: Auto-reconnect with exponential backoff (1s→2s→4s...30s cap). On WebSocket 4001 (auth failure), auto-refreshes token via `POST /auth/refresh` then reconnects. Manual reconnect still available via status dot. On `ConnectedEvent` with `chat_active`, loads persisted messages from DB (incremental persistence — each message saved server-side on role boundary) and enters streaming mode.
- Typing indicator: bouncing dots inside bubble before first chunk; "Done" checkmark after

### Streaming TTS (Always On)
- TTS always active (no toggle). Accumulates content in buffer; on sentence boundary (`.!?。！？\n`), queues via `useTTS().queueText()`
- Parallel synthesis, sequential FIFO playback
- Flushes buffer on agent change or DoneEvent; `clearQueue()` on cancel/new send
- Tool messages excluded; voice reference tracked per-agent
- Action narration (`*walks over*`) stripped via `stripNarration()` before TTS — preserves `**bold**`
- **Subtitles**: `useTTS` parses WAV header for duration, calls `onPlaybackStart(text, duration)` before each queue item plays. On TTS error, falls back to 4s duration. ChatWidget forwards to character window via IPC.

### Interactive Mode
Two-level state managed by `useMicStore` (Zustand, `src/store/micStore.ts`): `interactiveMode` (outer) + `interactionActive` (inner substate).

**Typing (default, `interactiveMode: false`)**:
- Mic on → ASR transcript placed into input field as dictation text → user presses Send manually
- Trigger word detection: if transcript contains agent's `trigger_word` (case-insensitive), enables interactive mode + activates interaction + auto-sends that transcript
- Mic button: red icon when listening, default when idle. No pulse animation.

**Interactive (`interactiveMode: true`)**:
- Entire bottom input area replaced by `InteractiveCallBar` — centered layout with transcript display, large 64px mic button, status text, red Hang Up button
- **Auto mic**: Entering → `startListening()` if idle; exiting → `stopListening()`. Input field cleared on entry.
- **Entry**: Phone toggle in MainWindow top bar, or trigger word match in typing mode
- **Exit conditions**: Hang up button, phone toggle, agent change, conversation change

**Interaction substates within interactive mode**:
- **Idle (`interactionActive: false`)**: Mic listens, transcripts shown visually but NOT sent. Status text: "Waiting for trigger word...". Mic button grey, no pulse ring. Awaiting trigger word to activate.
- **Active (`interactionActive: true`)**: All ASR transcripts auto-send (or queue via `pendingAutoSendRef` if streaming). Status text: "Listening..."/"Processing..."/"Thinking..."/"Speaking...". Mic button primary color with pulse ring animation.
- **Activation**: Trigger word detected in transcript → `activateInteraction()` + auto-send. Sound effect: `start_effect.wav`.
- **Deactivation**: 30s idle after TTS+streaming finish → `deactivateInteraction()` (stays in interactive mode, keeps listening). Sound effect: `stop_effect.wav`.
- **Config**: `agent.trigger_word`, managed in the AgentsSection edit dialog, stored in the backend DB

### Conversation Management (One Per Agent)
- **Agent sidebar** (`AgentSidebar.tsx`): Left drawer toggled via hamburger button. Shows all agents with avatar, name, last message preview, and relative timestamp. Agent previews loaded from `GET /conversations` (includes `last_message`), matched to agents via localStorage mapping. Refreshed on `loadAgents()`, `DoneEvent`, and clear conversation.
- Each agent has one conversation, managed via `kurisu_agent_conversations` localStorage mapping (`Record<string, number>`, agent ID → conversation ID)
- Agent selection triggers conversation load (or empty state if no mapping exists)
- **Fallback recovery**: When localStorage mapping is missing (cleared, new device, etc.), agent store queries `GET /conversations?agent_id=` to find the latest conversation with messages from that agent. If found, loads it and restores the localStorage mapping. If not found, shows empty state (conversation auto-created on first message).
- Backend auto-creates conversation on first message with `conversationId=null`; first `StreamChunkEvent` saves the mapping
- "Clear conversation" button deletes via API + removes mapping entry
- Mapping cleared on logout (`clearAllAgentConversations`) and agent delete (`clearAgentConversationId`)

### Auth Flow
- Login → POST /login → access token (1h) + refresh token (30d) → stored in apiClient + localStorage (if rememberMe)
- App startup: `initializeAuth()` → sets refresh token on apiClient → validates via GET /users/me → auto-refreshes on 401 via axios interceptor
- Token refresh: `POST /auth/refresh` with refresh_token body → returns new access_token. Coalesced (concurrent 401s share one refresh call). On success, persists new token if rememberMe. On failure, triggers logout.
- WebSocket auth failure (4001): wsManager auto-refreshes via apiClient.tryRefresh() then reconnects

### QR Code Login (generator)
- `AccountSection` → "Show login QR" button opens `LoginQrDialog` (`src/components/settings/LoginQrDialog.tsx`). User re-enters their password (we don't store it in plaintext); dialog calls `apiClient.verifyCredentials()` (a passwordless variant of `/login` that doesn't overwrite the session token), then renders a QR via the `qrcode` npm package onto a canvas.
- Shared payload format (must match Android scanner): `{"v":1,"server":"https://...","username":"foo","password":"bar"}`. Server URL comes from `storage.getBackendUrl()`; username from `useAuthStore().user.username`.
- The dialog warns that the QR is a credential. There is no logout-after-share or rotation step — user is responsible.

### Image Handling
- Upload: base64 images sent in `chat_request` WebSocket event → backend saves to per-user directory, returns UUIDs via `StreamChunkEvent.images`
- Display: `message.images[]` UUIDs rendered via `apiClient.getUserImageUrl(uuid)` → `GET /images/u/{uuid}?token=` (auth-required, per-user scoped)
- Streaming: `StreamChunkEvent.images` merged into current streaming message's images array
- Tool images: MCP tools returning `ImageContent` produce image UUIDs streamed on tool-role chunks
- Public images (avatars, faces): still use `apiClient.getImageUrl(uuid)` → `GET /images/{uuid}` (public)

### Display Modes & Token Usage
- **All Messages** (default): Full conversation history across all frames, paginated on scroll-up
- **Context Window**: Only messages after compaction watermark (`id > compactedUpToId`) + collapsible compacted context summary banner
- Toggle via `ToggleButtonGroup` above messages pane; scrolls to bottom on switch
- **Token count**: Always visible as "used / cap". Frontend-calculated: `(compacted_context + context_window_messages) * 1.3` word estimate. During streaming, backend `StreamChunkEvent.token_count` overrides
- Store tracks `compactedUpToId`, `compactedContext`, `systemPromptTokenCount` from `GET /conversations/{id}` response. `ContextInfoEvent` updates watermark live after compaction
- Compacted messages: resend disabled (backend blocks deletion too)

### Slash Commands (`src/utils/commands.ts`)
- `/compact` — compact conversation context (sends `compact_context` WebSocket event)
- `/clear` — delete current conversation + clear agent mapping (lazy imports to avoid circular deps)
- Autocomplete dropdown in `ChatComposer`: filtered on `/` prefix, Enter auto-selects first match, closes dropdown after selection
- All `/`-prefixed input intercepted client-side, never sent to backend
- Commands return feedback strings shown as info toasts
- `handleCommand()` is async, returns `Promise<string | null>`

### Prompt History
- Session-scoped prompt history tracked in `ChatComposer` via `promptHistoryRef`
- Arrow Up: browse previous prompts (saves current draft in `draftRef`)
- Arrow Down: browse forward or return to draft
- Only active when command dropdown is closed

### Keyboard Shortcuts
- **Esc**: Cancel streaming (only during active stream)
- **Enter**: Send message (or select command if dropdown open)
- **Shift+Enter**: Newline
- **Arrow Up/Down**: Prompt history (or command dropdown navigation)
- **Tab**: Select command in dropdown

### Pagination
- 20 messages/page, newest first. Scroll to top triggers `loadMoreMessages()`. Position preserved. Loading indicator hidden in Context display mode.

## Testing

E2E tests live in `tests/` and run via Playwright's Electron support.

- `playwright.config.ts` — serial, single worker (each test spawns its own Electron + mock backend).
- `tests/fixtures.ts` — `test` fixture that launches Electron pointing at `dist-electron/main.js` with an isolated userData dir (via `KURISU_E2E_USER_DATA_DIR` env var, which `electron/main.ts` honors for tests only), starts a mock backend on a random port, and seeds `kurisu_backend_url` in localStorage before reload.
- `tests/mock/server.ts` — HTTP + WebSocket mock implementing login/profile/agents/conversations/models/tools/mcp-servers endpoints and the `/ws/chat` streaming protocol. Configurable via `setStream`, `setTools`, `addMcpServer`. `dropAllWebSockets()` simulates a silent backend socket loss. Tracks `lastChatRequest` and `lastMcpServerCreate` for assertions.
- Specs: `smoke.spec.ts`, `streaming.spec.ts`, `settings.spec.ts`, `mcp.spec.ts`, `resilience.spec.ts`.

Commands: `npm run test:e2e:build` (vite build → `dist/` + `dist-electron/`), then `npm run test:e2e` (or `test:e2e:headed` for debugging).

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
- `GET /mcp-servers`, `POST /mcp-servers`, `PATCH /mcp-servers/{id}`, `DELETE /mcp-servers/{id}` — MCP server CRUD (location: server|client)
- `POST /mcp-servers/{id}/test` — Test MCP server connectivity (server-side only)

## Character Animation

Separate Electron window (toggleable via Face icon in top bar). Opens as independent, resizable (aspect-ratio-locked 2:3) frameless BrowserWindow — same Vite bundle routed via `?window=character` query param → `CharacterWindowApp` (no auth, no stores, purely IPC-driven). Default 512×768, min 256×384.

**IPC channels** (main renderer → main process → character renderer):
- `character:amplitude` — `{ amplitude, isPlaying, isThinking }` at ~30fps via setInterval
- `character:agents-update` — `{ agents: [{id, name, poseTree}], activeAgentId }` on agent map or active agent change
- `character:gesture-update` — `{ gestures: string[] }` forwarded from vision pipeline to trigger pose transitions
- `character:subtitle` — `{ text: string, isUser: boolean, duration?: number }` subtitles displayed as overlay at bottom of character window. Agent text: `sentenceDuration = chunkDuration / sentenceCount` (chunk split on `.!?。！？\n`). TTS success → chunkDuration = WAV duration; TTS error → chunkDuration = 4s. Sentences queued and shown sequentially, chaining immediately, fade only after last. User text shown immediately with word-count-based hold. Empty text clears (cancel).
- `character:window-closed` — main process → main renderer when user closes character window
- `character:open-window` / `character:close-window` — renderer invokes main process to create/destroy window

**Canvas compositing**: Base image + diff patches (eyes, mouth) at stored positions. Blink: configurable random interval state machine (default 2-6s). Breathing: sine wave vertical offset (configurable amplitude/period). Lip sync: audio amplitude → mouth patch index. Per-agent character configs stored in backend DB as JSON. **State machine**: IDLE (blink/breathing/mouth + event listening) → TRANSITIONING (playing edge video on canvas, all events ignored) → IDLE (switch to target pose, apply node settings, reset timers). During transitions no events are processed; random timers start fresh when arriving at a node. **Multi-transition edges**: Each directed edge (`AnimationEdge`) contains `transitions: EdgeTransition[]` — multiple transitions per edge, each with its own condition, video list, and playback rate. One edge per directed node pair (ID: `{source}-{target}`). Timer keys use `${edge.id}:${transitionIndex}`. Legacy edges (single condition/video_urls/playback_rate) auto-migrated on load via `migrateEdgeToTransitions()`. Legacy IDs (`pose-*`/`edge-*`) auto-migrated to 8-char random hex via `migratePoseTreeIds()` (calls `POST /character-assets/{agent_id}/migrate-ids` to rename files on disk). Bidirectional edges render side-by-side with perpendicular offset (not overlapping). Transition conditions: `random` (timer-based), `thinking` (fires when `isThinking` matches `condition.value`), `gesture` (fires when detected gesture matches `condition.value`, e.g. "wave", "thumbs_up", "peace_sign"). `isThinking` is a live variable observed each frame while idle — no edge detection. If multiple transitions satisfy simultaneously, one is chosen at random. `isThinking` piggybacked on amplitude IPC channel at ~30fps. **Per-node animation settings**: `AnimationNode.animation_settings` (optional) configures breathing (enabled/amplitude/period) and blink timing (min/max interval, close/hold/open duration). Applied via `applySettings()` on each pose switch. UI: sliders in PoseNodeEditor Preview step.

**Asset pipeline**: AI-generated base → inpainted variants → backend OpenCV diff → cropped patch PNGs. Assets stored in folder structure: `data/character_assets/{agent_id}/{pose_id}/base.png`, `{part}_{index}.png`; videos in `{agent_id}/edges/{edge_id}.mp4|.webm`. Re-uploading overwrites without changing URLs. Orphaned assets cleaned up on config save.

**Data flow**: ChatWidget fetches the agent's character_config on agent switch during streaming → builds agentMap (with poseTree, not poseConfig) + activeAgentId → sends via IPC to character window. TTS amplitude ref read by setInterval(33ms) and sent via IPC. CharacterWindowApp receives IPC data and renders CharacterRenderer components. CharacterRenderer calls `compositor.loadPoseTree()` to load all poses + initialize edge timers. CanvasCompositor reads amplitude at 60fps from local ref.

**Graph editor (CharacterConfigDialog)**: React Flow (@xyflow/react) canvas with custom `poseNode` nodes. Nodes represent poses; one edge per directed node pair containing multiple transitions. Connecting an existing pair opens the edge editor instead of creating a duplicate. Sub-dialogs: PoseNodeEditor (3-step stepper for base/patches/preview), EdgeEditor (multi-transition cards with per-transition condition/video/playback rate). Right-click node for context menu (Toggle Default, Edit, Delete). Multiple nodes can be marked as default (`default_pose_ids: string[]`); one chosen randomly at runtime. Conversion: poseTreeToReactFlow/reactFlowToPoseTree. Video upload naming: `${edge.id}_t${transitionIdx}_${videoIdx}`.

## Storage Keys (localStorage)

`kurisu_auth_token`, `kurisu_refresh_token`, `kurisu_remember_me`, `kurisu_selected_model`, `kurisu_backend_url`, `kurisu_tts_backend`, `kurisu_tts_voice`, `kurisu_tts_language`, `kurisu_tts_emo_audio`, `kurisu_tts_emo_alpha`, `kurisu_tts_use_emo_text`, `kurisu_selected_agent_id`, `kurisu_agent_conversations`, `kurisu_media_volume`

## Client-Side MCP Servers

MCP servers can run locally on the Electron client (`location: "client"`) in addition to the backend (`location: "server"`). Client-side servers access local files, apps, etc.

**Architecture**: On WebSocket connect → fetch MCP configs from API → filter `location="client"` → start local processes via Electron IPC (`electron/mcp.ts`) → discover tools → register schemas with backend via `client_tools_register` WebSocket event. Backend stores client tool schemas in handler state and includes them in LLM tool calls. When LLM calls a client tool, backend sends `tool_call_request` via WebSocket → client executes locally → sends `tool_call_response` back → backend continues LLM loop (120s timeout).

**IPC bridge** (`window.electron.mcp`): `startServers(configs)` → `{name, ok, error}[]`, `stopServers()`, `listTools()` → tool schemas, `callTool(name, args)` → `{content, isError}`.

**WebSocket events**: `client_tools_register` (client→server, tool schemas), `tool_call_request` (server→client, request_id + tool_name + args), `tool_call_response` (client→server, request_id + content + is_error).

**UI**: ToolsWindow server cards show Internal/External chip badge. Create/edit dialog has Location dropdown (External=server, Internal=client). Config changes trigger `refreshClientMCPServers()`.

## Security

- contextIsolation enabled, nodeIntegration disabled
- Token validated on startup (not blindly trusted)
- Tokens in localStorage (renderer-only, no XSS risk with contextIsolation)
- Self-signed certificates accepted via `certificate-error` handler (for direct HTTPS connections to backend)
