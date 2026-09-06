# Architecture

[← clients/desktop](../CLAUDE.md)

The file map for `clients/desktop/`. Read this before adding a file, and update it in the same change — a map that points at something that no longer renders is worse than no map (see #138).

```
electron/main.ts          — Multi-window Electron entry + auto-updater + single instance lock + IPC registration (MCP, host tools, app tools, explorer)
electron/mcp.ts           — MCP server manager: start/stop stdio/SSE servers, tool discovery/execution. A stdio spawn runs a program on the user's machine, so it asks first (native dialog, exact command line, Once / Always / Cancel) unless that command line is already in `mcp_stdio_consent`. IPC: mcp:start-server(s), mcp:stop-servers, mcp:list-tools, mcp:call-tool, mcp:is-server-running, mcp:get|set-playwright-autostart, mcp:get-approved-spawns, mcp:revoke-approved-spawn
electron/hostTools.ts     — Host tools: host_read/write/edit/search/bash, and the approval gate around them. `allowed_paths` (in settings.json, one global list — not per-agent, not per-persona) is a hard boundary: a file tool whose target is outside every grant is refused after the gate, not merely prompted. Grants are the persisted list, this session's approvals, and the path just approved for this call. Bash is exempt and approved per exact command instead, because a shell command reaches wherever it likes from any directory.
electron/hostToolPolicy.ts — The gate's rules, electron-free so they are unit-tested directly (`tests/hostToolPolicy.test.ts`): the rule key a decision is stored under, the paths a call would touch, and whether a path is inside a grant (via realpath, so a symlink out of an allowed directory does not pass a prefix test).
electron/mcpConsent.ts    — Which local MCP spawns the user has agreed to, keyed on the command line rather than the server's name: renaming a server keeps consent, editing what it runs asks again.
electron/appTools.ts      — App config tools: assistant capability (`app_get/update_assistant`), persona CRUD, sub-agent CRUD, MCP servers, skills, vision, UI navigation, browser launch (CDP). Forwards to the renderer via IPC round-trip; every advertised name must have a case in `src/services/appToolsHandler.ts` (`tests/appTools.test.ts` enforces it).
electron/explorerIPC.ts   — Unsandboxed file explorer IPC: list-directory, read-file, write-file, is-binary, has-vscode, open-in-vscode. Its root listing enumerates *this machine's* drives only; Kurisu Drive is appended in the renderer by `src/api/fileSource.ts`, because the main process cannot know a server exists.
electron/driveTransfers.ts — Streamed Kurisu Drive uploads and downloads. In main rather than the renderer because a drive file can be gigabytes: bytes go straight between disk and socket, and progress comes back over `drive:transfer-progress`. Writes multipart by hand so the body can stream, and downloads to a `.part` name renamed on completion. IPC: drive:pick-files, drive:upload, drive:download, drive:cancel.
electron/credentials.ts   — Session tokens, encrypted with `safeStorage` (OS keychain) into `credentials.json` in userData. With no keychain available nothing is written at all and `isSecure` says so, rather than falling back to plaintext. IPC: credentials:is-secure|read|write|clear.
electron/mcpServer.ts     — The app *as* an MCP server: publishes every host and app tool over SSE for an external client (Claude Code). 127.0.0.1 only, no CORS headers, and a bearer token minted on first run into settings.json — shown in Settings → Tools & MCP. IPC: mcp-server:get-info, mcp-server:rotate-token.
electron/mcpServerAuth.ts — The guard in front of that server, electron-free so it is unit-tested directly (`tests/mcpServerAuth.test.ts`): refuses anything carrying browser headers (Origin, Referer, Sec-Fetch-*) and requires the bearer token everywhere but /health.
electron/settings.ts      — The main process's settings.json under userData (host-tool approvals, MCP token, first-run flags). One loader/saver: three modules had private copies, and two writes in the same tick dropped each other's keys.
electron/preload.ts       — contextBridge: hostTools, appTools, explorer, drive, mcp, mcpServer, credentials, characterWindow, extensions, updater. Anything added here must also be declared in `src/types/electron.d.ts` or it is untyped.
src/api/client.ts         — Axios + WebSocket singleton; streaming + media via wsManager; assistant/persona/sub-agent REST; migrateCharacterIds(). Interceptors: 401 → refresh, 426 → `onProtocolMismatch` (the update screen); `getModelsWithStatus()` carries `/models`' `unavailable` list
src/api/types.ts          — TypeScript interfaces for API (Assistant / Persona / SubAgent — the old `Agent` is split three ways; DriveNode / DriveUsage for the drive)
src/api/fileSource.ts     — **One explorer, two roots.** The same 9 members as `window.electron.explorer`, dispatching on a `drive://` prefix: local paths pass straight through to the bridge, drive paths go to the REST API. Owns `joinPath`/`dirnameOf`/`basenameOf`, which pick the separator from the path — a drive path is POSIX-shaped on every platform, and four modules used to hard-code the host separator and get that wrong on Windows. Also owns the path→node-id cache, so no component learns that node ids exist.
src/constants.ts          — WIRE_PROTOCOL (6), the `kurisu.auth.bearer` / `kurisu.wire.<n>` WebSocket subprotocol names, and `WS_ERROR_NO_MODEL_SELECTED` (the one `error` code this client branches on)
src/components/
  layout/
    MainLayout.tsx         — 3-panel layout: ActivityBar (52px) | MainContent (flex) | ResizeHandle | ChatPanel (resizable)
    ActivityBar.tsx        — Narrow icon column: Workspace/Conversations/Settings nav + transfers (badged) + connection/character/call/logout
    ChatPanel.tsx          — Persistent right panel: a static "Chat" header bar + ChatWidget. The persona sheet lives on the chat header inside ChatWidget, not here.
    ResizeHandle.tsx       — DOM-based drag resize (no React re-renders during drag, sync on mouseup)
  explorer/
    FileExplorerPage.tsx   — Workspace page: FullExplorer (no files open) or FileTreeSidebar + EditorTabs + FileEditor
    FullExplorer.tsx       — Full-page file browser: a Sources rail (this computer + Kurisu Drive), breadcrumb, list/grid views, multi-select (Ctrl/Shift/lasso), a **Where it lives** column, Upload/Download, and OS drag-and-drop onto a drive folder. Uses useFileOperations, ExplorerContextMenus, ExplorerDialogs. Everything it reads goes through `fileSource`, never the bridge directly.
    ExplorerContextMenus.tsx — File context menu (rename/copy/cut/delete/open/add-to-chat, plus Download a copy on the drive and Upload to Kurisu Drive locally) + background context menu (new file/folder/paste/open in VS Code)
    ExplorerDialogs.tsx    — Rename dialog + New File/Folder dialog
    FileTreeSidebar.tsx    — The tree, in two modes. With no props it follows `workspaceRoot` (editor mode). With `rootPath=""` it is the **Sources** rail: this computer's roots and Kurisu Drive side by side, with `showQuota` putting the drive's usage bar at its foot. Lazy-loads children through `fileSource`, resizable, right-click Open Folder/Add to Chat.
    DriveQuotaBar.tsx      — How full the drive is, at the foot of the Sources rail. Refetched when a transfer finishes.
    TransferTray.tsx       — The transfer tray: one non-blocking home for uploads and downloads, with per-row progress, the server's own failure sentence, and Cancel. Mounted in MainLayout, not the explorer — a transfer outlives the page that started it.
    EditorTabs.tsx         — Tab bar: file icon + name, dirty dot, middle-click/X close, right-click Add to Chat, tooltip with full path
    FileEditor.tsx         — Monaco editor: Ctrl+S save, auto-detect language, binary detection with Open Anyway, image preview, selection→chat context
    FileIcon.tsx           — Custom SVG icons by type (folder, TS, JS, PY, JSON, MD, HTML, CSS, image, config, default)
  conversations/
    ConversationsPage.tsx  — Persona list with search, avatar, last message preview, timestamps. Click loads conversation into ChatPanel.
  settings/
    SettingsPage.tsx       — Left nav sidebar (13 sections) + lazy-loaded content area. `tests/settings.spec.ts` asserts the label list, so adding or renaming a section fails there until the spec agrees.
    AccountSection.tsx     — Ollama URL, summary model, context size
    TTSSection.tsx         — TTS backend, auto-play, voice, emotion controls, ASR language
    AppearanceSection.tsx  — Light/dark theme toggle
    AssistantSection.tsx   — The one assistant's capability form: model (+ provider, taken from the picker), tools, extended thinking, deferred tools, memory + memory notes, voice wake word, default persona. One PATCH of only the changed fields; Revert restores the last-loaded values. Nothing to create or delete — the assistant is made at registration.
    PersonasSection.tsx    — Persona grid (`ResourceCard`) + enable toggle, export, delete, import, New Persona. Delete is refused for the last persona and disabling the default is refused, both server-side; the detail comes back in the 400 and is shown as-is.
    PersonaEditDialog.tsx  — One persona, presentation only: avatar upload, name, description, system prompt, "Calls you" (`preferred_name`), voice (`GET /tts/voices`, an unlisted saved value kept as an option), and a button into `CharacterConfigDialog` for `character_config` — disabled while creating, since the graph's assets are stored under the persona id. The graph editor auto-saves through `PATCH /character-assets/{persona_id}/character-config`, so this form never sends `character_config` back; the section reloads on dialog close instead of on save, so an auto-save cannot replace the persona under an open form.
    SubAgentsSection.tsx   — Sub-agent grid + the same toggle/export/delete/import actions.
    SubAgentEditDialog.tsx — One sub-agent: name, description, task instructions, model (empty = the assistant's), tools, thinking, deferred tools. No avatar, voice, memory or wake word — a sub-agent has no identity.
    ResourceCard.tsx       — The card both grids use: avatar/icon, name, description, clamped prompt, caption line, enabled switch, export + delete.
    useAvailableTools.ts   — The tool list both capability forms pick from: backend MCP + built-ins, plus this Electron process's host/app tools, deduped and grouped.
    MCPServersSection.tsx  — Local servers detection (Maestro, Chronicle, Playwright) + user MCP server CRUD
    ToolsSection.tsx       — The merged "Tools & MCP" page: available tools, local server detection, user MCP server CRUD, and the card that shows this app's own MCP endpoint and bearer token. `SettingsPage` routes both `tools` and the legacy `mcp-servers` here.
    SkillsSection.tsx      — Skill CRUD + import/export
    DriveSection.tsx       — Kurisu Drive: how full it is, and the three-way Assistant access choice (read only / ask before writing / full access). Not a new setting — a **view over `users.tool_policies`**, writing the four drive tools' entries. Anything that matches none of the three reads back as Custom and is left to Tools & MCP.
    HostAccessSection.tsx  — Allowed-paths config: the boundary itself, one global list shared by every host tool call, with no per-agent or per-persona scoping. Entries can be files as well as directories now, since "Always" grants the exact path.
    FacesSection.tsx       — Face identity CRUD, detail/delete dialogs, vision preview
    FaceCreateDialog.tsx   — Face registration dialog: webcam capture, photo grid, name input. Uses useWebcamCapture hook.
    ExtensionsSection.tsx  — Companion app installer (Maestro, Chronicle)
  LoginWindow.tsx          — Login/Register tabs, Remember Me, Server URL field
  MessageBubble.tsx        — Re-exports from chat/ subfolder
  InteractiveCallBar.tsx   — Voice mode call bar: transcript, mic button with pulse, hang up
  chat/
    ChatWidget.tsx         — Chat UI with streaming, TTS, image attach, pagination, voice mode, selection context chips, display mode toggle (All/Context), token usage bar
    ChatComposer.tsx       — Message input composer with file attach, voice input, slash command autocomplete, prompt history (up/down arrows). Keyed on `personaId`/`conversationId`; drops the draft only when leaving a concrete conversation, never when the scope resolves (#145, docs/chat.md)
    SelectionChips.tsx     — File selection context chips
    MessageBubble.tsx      — Individual bubble: role styling, thinking collapse, TTS, resend/delete
    MessageToolbar.tsx     — Hover toolbar: copy, TTS play, raw data, resend/regenerate, delete
    RawDataDialog.tsx      — Dialog showing raw LLM input/output JSON (self-contained fetch)
    ToolApprovalBar.tsx    — Approve/deny bar for a pending tool call; replaces the composer while one is waiting
    NoModelPrompt.tsx      — Bar above the composer (not in place of it) when the account has no model chosen yet: "Choose a model" opens Settings → Assistant (#149)
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
  UpdateRequiredScreen.tsx — The wire-protocol gate: both numbers, which side is behind (`utils/wireProtocol.ts`), and "Change server" back to the login form (#150)
src/hooks/
  useTTS.ts               — TTS synthesis/playback: speak(), queueText(), clearQueue(), onPlaybackStart subtitle callback, WAV duration parsing. `backends` is only what `/tts/models` lists (no fallback list), `backendsError` says why it is empty (#151)
  useAudioAmplitude.ts    — Web Audio API amplitude for lip sync (AudioBufferSourceNode + time-domain RMS)
  useConnectionStatus.ts  — Hook subscribing to wsManager.onStatusChange() for connection status (connected/connecting/disconnected)
  useWebcamCapture.ts    — Webcam stream management: startWebcam(), stopWebcam(), captureFrame() → CapturedPhoto (File + preview). Refs for video/canvas elements. Cleanup on unmount.
  useFileOperations.ts   — File operation hook for explorer: clipboard (cut/copy), rename, create file/folder, delete, paste + keyboard shortcuts (Ctrl+C/X/V/A, F2, F3, Delete). Goes through `fileSource`, so the same actions work on the drive, and reports a refusal through `onError` rather than the console — a 409 or a full drive is something the user has to be told.
src/store/
  authStore.ts            — Auth state, login/register/logout, token persistence
  conversationStore.ts    — Current conversation + messages (paginated 20/page). No conversation list — persona selection drives conversation via localStorage mapping.
  personaStore.ts         — Persona list, selected persona ID (persisted), persona previews (last message per persona for the sidebar). Persona selection triggers conversation load via the persona-conversation mapping.
  layoutStore.ts          — Layout state: activePage (workspace/conversations/settings), chatPanelWidth, workspaceTreeWidth, settingsSection (persisted)
  explorerStore.ts        — The editor half of the explorer: open/close/save files, dirty detection, selections for chat context, view mode. Browsing state lives in `FullExplorer`, which is the only thing that renders it — the store used to carry a second, unrendered copy.
  transferStore.ts        — Uploads and downloads, and the tray. Holds the rows and the lifecycle; the bytes never pass through it (see `electron/driveTransfers.ts`).
  visionStore.ts          — Zustand singleton: vision pipeline control (getUserMedia webcam capture, backpressure-based frame upload as WebSocket **binary** messages (`src/api/binaryFrame.ts`; canvas → `toBlob` JPEG → bytes, never base64 or JSON — #111) with a capped number in flight, face/pose/hands toggles, WebSocket vision_result listener + gesture IPC forwarding). Syncs state on reconnect via `connected` listener. Used by both FacesWindow and ChatWidget camera toggle.
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
src/utils/storage.ts      — Preferences in localStorage (model, TTS settings, persona-conversation mapping) **and the in-memory half of token storage**. Tokens are never written to localStorage; `loadPersistedTokens()` fills memory from the keychain once at startup (migrating and deleting any plaintext pair an older build left), and `getToken()` stays synchronous for the authed asset URLs that call it on render paths.
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
