# Architecture

[← clients/desktop](../CLAUDE.md)

The file map for `clients/desktop/`. Read this before adding a file, and update it in the same change — a map that points at something that no longer renders is worse than no map (see #138).

```
electron/main.ts          — Multi-window Electron entry + auto-updater + single instance lock + IPC registration (MCP, host tools, app tools, explorer)
electron/mcp.ts           — MCP server manager: start/stop stdio/SSE servers, tool discovery/execution. A stdio spawn runs a program on the user's machine, so it asks first (native dialog, exact command line, Once / Always / Cancel) unless that command line is already in `mcp_stdio_consent`. IPC: mcp:start-server(s), mcp:stop-servers, mcp:list-tools, mcp:call-tool, mcp:is-server-running, mcp:get|set-playwright-autostart, mcp:get-approved-spawns, mcp:revoke-approved-spawn
electron/hostTools.ts     — Host tools: host_read/write/edit/search/bash, and the approval gate around them. `allowed_paths` (in settings.json, one global list — not per-agent, not per-persona) is a hard boundary: a file tool whose target is outside every grant is refused after the gate, not merely prompted. Grants are the persisted list, this session's approvals, and the path just approved for this call. Bash is exempt and approved per exact command instead, because a shell command reaches wherever it likes from any directory.
electron/hostToolPolicy.ts — The gate's rules, electron-free so they are unit-tested directly (`tests/hostToolPolicy.test.ts`): the rule key a decision is stored under, the paths a call would touch, and whether a path is inside a grant (via realpath, so a symlink out of an allowed directory does not pass a prefix test).
electron/mcpConsent.ts    — Which local MCP spawns the user has agreed to, keyed on the command line rather than the server's name: renaming a server keeps consent, editing what it runs asks again.
electron/appTools.ts      — App config tools: assistant capability (`app_get/update_assistant`), persona CRUD, sub-agent CRUD, MCP servers, skills, vision, UI navigation, browser launch (CDP). Forwards to the renderer via IPC round-trip; every advertised name must have a case in `@kurisu/state`'s `appToolsHandler.ts` (`tests/appTools.test.ts` enforces it).
electron/explorerIPC.ts   — Unsandboxed file explorer IPC: list-directory, read-file, write-file, is-binary, has-vscode, open-in-vscode. Its root listing enumerates *this machine's* drives only; Kurisu Drive is appended in the renderer by `@kurisu/api`'s `fileSource.ts`, because the main process cannot know a server exists.
electron/driveTransfers.ts — Streamed Kurisu Drive uploads and downloads. In main rather than the renderer because a drive file can be gigabytes: bytes go straight between disk and socket, and progress comes back over `drive:transfer-progress`. Writes multipart by hand so the body can stream, and downloads to a `.part` name renamed on completion. IPC: drive:pick-files, drive:upload, drive:download, drive:cancel.
electron/credentials.ts   — Session tokens, encrypted with `safeStorage` (OS keychain) into `credentials.json` in userData. With no keychain available nothing is written at all and `isSecure` says so, rather than falling back to plaintext. IPC: credentials:is-secure|read|write|clear.
electron/mcpServer.ts     — The app *as* an MCP server: publishes every host and app tool over SSE for an external client (Claude Code). 127.0.0.1 only, no CORS headers, and a bearer token minted on first run into settings.json — shown in Settings → Tools & MCP. IPC: mcp-server:get-info, mcp-server:rotate-token.
electron/mcpServerAuth.ts — The guard in front of that server, electron-free so it is unit-tested directly (`tests/mcpServerAuth.test.ts`): refuses anything carrying browser headers (Origin, Referer, Sec-Fetch-*) and requires the bearer token everywhere but /health.
electron/settings.ts      — The main process's settings.json under userData (host-tool approvals, MCP token, first-run flags). One loader/saver: three modules had private copies, and two writes in the same tick dropped each other's keys.
electron/preload.ts       — contextBridge: hostTools, appTools, explorer, drive, mcp, mcpServer, credentials, characterWindow, extensions, updater. Anything added here must also be declared in `@kurisu/platform`'s `types.ts` (`src/types/electron.d.ts` only declares the global) or it is untyped, and reached through `resolveBridge()` rather than `window.electron` by anything below a component.
@kurisu/api client.ts     — Axios + WebSocket singleton; streaming + media via wsManager; assistant/persona/sub-agent REST; migrateCharacterIds(). Interceptors: 401 → refresh, 426 → `onProtocolMismatch` (the update screen); `getModelsWithStatus()` carries `/models`' `unavailable` list
@kurisu/models            — the wire protocol, shared by every TS app: API interfaces (Assistant / Persona / SubAgent — the old `Agent` is split three ways; DriveNode / DriveUsage), the event-name unions, `WIRE_PROTOCOL`, the binary vision frame, `FileEntry`, and the character/pose types. Lives in `clients/packages/models` (#128)
@kurisu/api fileSource.ts — **One explorer, two roots.** The same 9 members as `window.electron.explorer`, dispatching on a `drive://` prefix: local paths pass straight through to the bridge, drive paths go to the REST API. Owns `joinPath`/`dirnameOf`/`basenameOf`, which pick the separator from the path — a drive path is POSIX-shaped on every platform, and four modules used to hard-code the host separator and get that wrong on Windows. Also owns the path→node-id cache, so no component learns that node ids exist.
@kurisu/platform          — what the host lends the renderer, behind one interface: files, transfers, credentials, host tools, MCP, the character window, plus a `capabilities` record and the host's own `appVersion` (the desktop package.json's version, baked into the preload by a Vite `define` — not `app.getVersion()`, which an unpackaged run answers with Electron's own number; `null` in a browser, #257). `resolveBridge()` returns the Electron implementation here and a browser stub elsewhere
@kurisu/api               — the server as this client calls it: the REST client, the WebSocket and its handshake, where tokens live, the drive/local file sources. No React (#187)
@kurisu/state             — zustand stores (conversations, personas, explorer, transfers, vision, tool permissions), the app-tool dispatch, and slash-command parsing
@kurisu/hooks             — the React bindings over those two: streaming chat, TTS, interactive ASR, the character panel, webcam, connection status
@kurisu/vrm               — the 3D character driver (#239): `createVrmDriver(canvas)` implements `CharacterDriver` (`@kurisu/models` `characterDriver.ts`, the contract both character kinds share) over three.js + `@pixiv/three-vrm` — loads a model and its VRMA clips from bytes the host resolves, lip-syncs from the sentence's amplitude, blinks and idles procedurally (`driver/{lipSync,idle,expressions,reactionTable}.ts` are pure and unit-tested), plays clips with a per-frame authority order, applies emotion cues. `supportsWebGL()` from `@kurisu/vrm/probe` (engine-free) is asked before the chunk is imported. A parsed model is cached per `url@sha256` and handed to one driver at a time — a second live driver on the same persona (the editor's preview beside the window) parses its own copy rather than stealing the first's scene graph — and every procedural rotation is conjugated for a VRM 0.x rig, which faces the other way from a 1.0 one. `page/host.ts` is the message protocol the Android page decodes, with golden fixtures. `@kurisu/vrm/testing` exports the driver conformance cases and the fakes. `CharacterSurface` mounts it for a VRM persona, by dynamic import only (#240)
@kurisu/ui  (clients/packages/ui/src/components/)
  layout/
    MainLayout.tsx         — 3-panel layout: ActivityBar (52px) | MainContent (flex) | ResizeHandle | ChatPanel (resizable)
    ActivityBar.tsx        — Narrow icon column: Workspace/Conversations/Settings nav + transfers (badged) + connection status + logout. The character window's toggle is the Face icon on the chat header inside ChatWidget, not here (#237).
    ChatPanel.tsx          — Persistent right panel: a static "Chat" header bar + ChatWidget. The persona sheet lives on the chat header inside ChatWidget, not here. Owns the character window's open/closed state: `kurisu:toggle-character` (the Face icon, `/live-animate`) opens or closes it through the bridge, `onWindowClosed` clears it (#237).
    ResizeHandle.tsx       — DOM-based drag resize (no React re-renders during drag, sync on mouseup)
  explorer/
    FileExplorerPage.tsx   — Workspace page: FullExplorer (no files open) or FileTreeSidebar + EditorTabs + FileEditor
    FullExplorer.tsx       — Full-page file browser: a Sources rail (this computer + Kurisu Drive), breadcrumb, list/grid views, multi-select (Ctrl/Shift/lasso), a **Where it lives** column, Upload/Download, and OS drag-and-drop onto a drive folder. Uses useFileOperations, ExplorerContextMenus, ExplorerDialogs. Every read of a file or folder goes through `fileSource`. Content search is the exception and stays on the bridge, because ripgrep runs on this machine — it is gated on `fileSource.supportsSearch`, so a drive folder offers no search rather than searching the wrong tree.
    ExplorerContextMenus.tsx — File context menu (rename/copy/cut/delete/open/add-to-chat, plus Download a copy on the drive and Upload to Kurisu Drive locally) + background context menu (new file/folder/paste/open in VS Code)
    ExplorerDialogs.tsx    — Rename dialog + New File/Folder dialog
    FileTreeSidebar.tsx    — The tree, in two modes. With no props it follows `workspaceRoot` (editor mode). With `rootPath=""` it is the **Sources** rail: this computer's roots and Kurisu Drive side by side, with `showQuota` putting the drive's usage bar at its foot. Lazy-loads children through `fileSource`, resizable, right-click Open Folder/Add to Chat.
    DriveQuotaBar.tsx      — How full the drive is, at the foot of the Sources rail. Refetched when a transfer finishes.
    TransferTray.tsx       — The transfer tray: one non-blocking home for uploads and downloads, with per-row progress, the server's own failure sentence, and Cancel. Mounted in MainLayout, not the explorer — a transfer outlives the page that started it.
    EditorTabs.tsx         — Tab bar: file icon + name, dirty dot, middle-click/X close, right-click Add to Chat, tooltip with full path
    FileEditor.tsx         — Monaco editor: Ctrl+S save, auto-detect language, binary detection with Open Anyway, image preview, selection→chat context
    FileIcon.tsx           — Custom SVG icons by type (folder, TS, JS, PY, JSON, MD, HTML, CSS, image, config, default)
  conversations/
    ConversationsPage.tsx  — Persona list with search, last message preview, timestamps (no avatar, #192). Click loads conversation into ChatPanel.
  settings/
    SettingsPage.tsx       — Left nav sidebar (13 sections) + lazy-loaded content area. `tests/settings.spec.ts` asserts the label list, so adding or renaming a section fails there until the spec agrees.
    AccountSection.tsx     — Ollama URL, summary model, context size, and the version rows
    VersionRows.tsx        — App / Backend / Protocol, from the bridge's `appVersion` and `GET /version`, with one sentence when the app and the backend are different releases (#257). The fetch is injectable so the rows are unit-tested under happy-dom
    TTSSection.tsx         — TTS backend, auto-play, voice, ASR language
    AppearanceSection.tsx  — Light/dark theme toggle
    AssistantSection.tsx   — The one assistant's capability form: tools, extended thinking, deferred tools, memory + memory notes, voice wake word. No model and no default persona (#197): the model is picked from the chat header's menu, the default persona from PersonasSection's "Make default". One PATCH of only the changed fields; Revert restores the last-loaded values. Nothing to create or delete — the assistant is made at registration.
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
    NoModelPrompt.tsx      — Bar above the composer (not in place of it) when the account has no model chosen yet: "Choose a model" opens the header's model menu in place (#149, #197)
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
  UpdateRequiredScreen.tsx — The wire-protocol gate: both numbers, which side is behind (`@kurisu/api`'s `wireProtocol.ts`), the update offer when this app is behind (#264) and "Change server" back to the login form (#150)
  useUpdateFlow.ts — One updater state machine (idle/checking/available/downloading/ready/none/unavailable/error) shared by `UpdateDialog` and the gate; `check()` asks the host now, the events report the download (#264)
@kurisu/hooks  (clients/packages/hooks/src/)
  useTTS.ts               — TTS synthesis/playback: speak(), queueText(), clearQueue(), onPlaybackStart subtitle callback. Publishes each spoken sentence to the character feed as a `SpeechSegment` (curve + `startedAt` from the audio element's `playing` event) and a `SpeechSync` every 500 ms; `null` when the queue drains (#238). `backends` is only what `/tts/models` lists (no fallback list), `backendsError` says why it is empty (#151)
  useAudioAmplitude.ts    — WAV parsed by hand for the RMS curve (no Web Audio); `playSegment()` plays a blob through a plain `Audio` and reports the curve on `playing` and the position while playing — nothing per frame leaves it
  useCharacterPanel.ts    — The persona half of the character feed: which personas are in the conversation and who is speaking, into `useCharacterStore`; subtitles as feed events
  characterBridgeSync.ts  — `mirrorCharacterFeed()`: the feed store → the character window over IPC while it is open, plus the `ready` and session-request handshakes; `useCharacterBridgeSync` is its `useEffect`, mounted in `ChatPanel` (#238)
  characterSession.ts     — `greetCharacterWindow()`: the session before the personas
  useConnectionStatus.ts  — Hook subscribing to wsManager.onStatusChange() for connection status (connected/connecting/disconnected)
  useWebcamCapture.ts    — Webcam stream management: startWebcam(), stopWebcam(), captureFrame() → CapturedPhoto (File + preview). Refs for video/canvas elements. Cleanup on unmount.
  useFileOperations.ts   — File operation hook for explorer: clipboard (cut/copy), rename, create file/folder, delete, paste + keyboard shortcuts (Ctrl+C/X/V/A, F2, F3, Delete). Goes through `fileSource`, so the same actions work on the drive, and reports a refusal through `onError` rather than the console — a 409 or a full drive is something the user has to be told.
@kurisu/state  (clients/packages/state/src/)
  authStore.ts            — Auth state, login/register/logout, token persistence
  conversationStore.ts    — Current conversation + messages (paginated 20/page). No conversation list — persona selection drives conversation via localStorage mapping.
  personaStore.ts         — Persona list, selected persona ID (persisted), persona previews (last message per persona for the sidebar). Persona selection triggers conversation load via the persona-conversation mapping.
  layoutStore.ts          — Layout state: activePage (workspace/conversations/settings), chatPanelWidth, workspaceTreeWidth, settingsSection (persisted)
  explorerStore.ts        — The editor half of the explorer: open/close/save files, dirty detection, selections for chat context, view mode. Browsing state lives in `FullExplorer`, which is the only thing that renders it — the store used to carry a second, unrendered copy.
  transferStore.ts        — Uploads and downloads, and the tray. Holds the rows and the lifecycle; the bytes never pass through it (see `electron/driveTransfers.ts`).
  visionStore.ts          — Zustand singleton: vision pipeline control (getUserMedia webcam capture, backpressure-based frame upload as WebSocket **binary** messages (`binaryFrame.ts` in `@kurisu/models`; canvas → `toBlob` JPEG → bytes, never base64 or JSON — #111) with a capped number in flight, face/pose/hands toggles, WebSocket vision_result listener writing gestures and faces into the character feed). Syncs state on reconnect via `connected` listener. Used by both FacesWindow and ChatWidget camera toggle.
  characterFeedStore.ts   — The live character feed (#238): frame-rate refs (`speech`, `speechSync`, `thinking`, `gestures` with a rising `seq`, `faces`) written by their producers and read by a surface's loop, an event stream over every write (what the IPC mirror and the subtitle queue hear), and `useCharacterStore` for the human-speed half — personas (kept by `characterFingerprint`), `activePersonaId`, `inlineVisible`, `windowOpen`, `restingEmotion`
  micStore.ts             — Zustand singleton: ASR lifecycle (VAD, status, result, devices) + interactive mode with substates. Module-level VAD instance, lazy-init reusable Audio elements for sound effects. Two-level state: `interactiveMode` (call bar UI shown, mic auto-started) + `interactionActive` (auto-send without trigger word). Used by ChatWidget (transcript handling, conditional render); nothing enters `interactiveMode` from the UI since the `MainWindow` phone toggle went (#253).
@kurisu/state, continued — no Electron needed, so it is shared
  mcpService.ts            — Client-side MCP lifecycle: auto-init on WebSocket connect, fetches client-location MCP configs from API, starts local servers via Electron IPC, discovers tools, registers schemas with backend via client_tools_register event. Handles tool_call_request forwarding (execute locally → send tool_call_response). refreshClientMCPServers() for config changes.
@kurisu/ui CharacterWindowApp — The second window's root: no login and no producers of its own (the access token is pushed to it over `character:session` and it fetches nothing until then); every IPC message is written into this renderer's copy of the character feed store, and `CharacterStack` renders a `CharacterSurface` per persona from it (one live 3D stage, other VRM personas as "waiting" cards); subtitle overlay from `SubtitleQueue`; a 24 px drag strip along the top, since a 3D stage opts out of the drag region
@kurisu/ui character/     — The seam every character kind sits behind (#238)
  CharacterSurface.tsx    — Owns the box, a ResizeObserver and the frame loop: samples the feed (`sampleSpeech` on its own clock, thinking, the gesture burst not yet taken, faces) and calls `driver.update`; picks the driver by `character.kind` — for `vrm`, asks `supportsWebGL` and only then `import('@kurisu/vrm')`; reloads on `characterFingerprint` change; retries a failed load on the next session bump, on "Try again" and on `online`; shows a VRM persona's no-model / loading (bytes of total) / failed / no-WebGL states (#240)
  CharacterStack.tsx      — The personas of a conversation, stacked, with at most one live WebGL stage: the active persona, else the last VRM persona to speak, else the first (`liveStagePersona`); the others are avatar cards (#240)
  PoseGraphDriver.ts      — `CharacterDriver` over the unchanged `CanvasCompositor`: writes its inputs, serialises loads (a newer one supersedes), refuses readably, idempotent dispose; passes `@kurisu/vrm/testing`'s conformance cases
  subtitleQueue.ts        — The subtitle logic, pure: one sentence at a time for its share of the audio, user line on interrupt, injectable timers
@kurisu/ui videocall/engine/ — The 2D engine, unchanged by the seam
  (types moved to @kurisu/models) — PoseConfig, PatchInfo, PoseTree, AnimationNode/Edge/EdgeTransition, TransitionCondition (random/thinking/gesture/face), AnimationSettings, CharacterConfig, migrateEdgeToTransitions(), migratePoseTreeIds() (old pose-*/edge-* IDs → 8-char hex); `characterDriver.ts` (the contract), `speech.ts` + `speechClock.ts` (the sentence and the mouth's clock), `characterFingerprint.ts`
    CanvasCompositor.ts   — 60fps render: blink + breathing + mouth + pose tree state machine (idle→transitioning→idle), edge timers, video transitions, configurable AnimationSettings. `CanvasCompositor.test.ts` pins its behaviour with a recording context and a hand-stepped loop
    ImageCache.ts         — URL→HTMLImageElement cache
@kurisu/api storage.ts    — Preferences in localStorage (model, TTS settings, persona-conversation mapping) **and the in-memory half of token storage**. Tokens are never written to localStorage; `loadPersistedTokens()` fills memory from the keychain once at startup (migrating and deleting any plaintext pair an older build left), and `getToken()` stays synchronous for the authed asset URLs that call it on render paths. Every change of the access token is pushed to the character window; `adoptToken()` is that window's way in — memory only, never the keychain (#237).
@kurisu/api authedFetch.ts — The one `fetch` with the bearer token (`fetchAuthedBlob`/`fetchAuthedBytes`, the latter with an optional byte-progress callback for a model download; `AssetRequestError` carries the refusing status, `DownloadInterruptedError` a body short of its `Content-Length`), behind every header-authenticated asset: the image cache, the compositor's videos and `useAuthedAssetUrl`. Retries once on a 401 through the refresher each renderer configures — `apiClient.tryRefresh` in the main window, a `character:session-request` round trip in the character window (#237).
@kurisu/state commands.ts — Slash command system: /compact, /clear. Autocomplete via getCommands(). Async handleCommand() with feedback strings. Lazy imports to avoid circular deps.
@kurisu/ui theme/theme.ts — MUI theme: primary #10A37F, 8px/12px border-radius
@kurisu/api config.ts     — API URL config (reads dynamically from storage)
```

## Code Style

- Functional components + hooks only
- Zustand for global state, useState for local
- MUI `sx` prop for styling (no CSS files)
- Framer Motion for animations
- Try/catch + MUI Alert for errors
- PascalCase components, camelCase stores
