# Architecture

[← clients/android](../CLAUDE.md)

The package layout and how the screens connect. Update it in the same change as
the code — a map that points at something that no longer exists is worse than no
map.

## Package layout

```
com.kurisu.assistant/
├── KurisuApplication.kt         -- @HiltAndroidApp
├── MainActivity.kt              -- Single activity, NavHost
├── data/
│   ├── local/                   -- DataStore, EncryptedPrefs, StorageKeys
│   ├── remote/api/              -- Retrofit service, interceptors, ProtocolMismatchSignal (live 426 / 4426 → update gate)
│   ├── remote/websocket/        -- OkHttp WebSocket, event payloads
│   ├── model/                   -- Data classes (API, WS, Animation, UpdateModels)
│   └── repository/              -- Auth, Assistant, Persona, SubAgent, Conversation, TTS, ASR, Vision, Tools, Face, Update repos
├── domain/
│   ├── chat/                    -- Stream processor, sentence splitter, narration stripper
│   ├── tts/                     -- TTS queue, WAV parser, amplitude computer
│   ├── audio/                   -- AudioRecorder, VoiceActivityDetector
│   └── character/               -- Compositor, image cache, animation migration
├── ui/
│   ├── navigation/              -- NavGraph + AppDrawerHost (routes: LOGIN, CONVERSATIONS, CHAT, ASSISTANT, PERSONAS, TOOLS_MCP, SKILLS, SETTINGS, ACCOUNT, TTS_ASR, APPEARANCE, FACES, ABOUT)
│   ├── theme/                   -- Material 3 theme (primary #2563EB)
│   ├── auth/                    -- Login screen + ViewModel
│   ├── conversations/           -- Chats list (start destination) + mic strip + in-app update check
│   ├── chat/                    -- Chat screen, message bubble, tool rail, input, markdown (no nav args)
│   ├── assistant/               -- The one assistant (model, tools, memory, wake word) + sub-agent CRUD
│   ├── personas/                -- Persona CRUD (name, prompt, voice, avatar) + ViewModel
│   ├── common/                  -- Shared UI bits (personaInitials, ModelDropdown)
│   ├── settings/                -- Settings index + Account, Appearance, TTS & ASR, Tools & MCP, Skills screens
│   ├── faces/                   -- Face Identities CRUD (camera capture via TakePicture intent + FileProvider)
│   ├── update/                  -- UpdateDialog composable (in-app update from GitHub Releases)
│   ├── version/                 -- Wire-protocol gate: UpdateRequiredScreen + UpdateRequiredCopy (which side to update)
│   └── character/               -- Character canvas, video player, screen + ViewModel
├── service/                     -- CoreService (foreground service), CoreState (shared singleton), VoiceInteractionManager
└── di/                          -- Hilt modules (App, Network)
```

## Navigation flow

```
Launch → GET /version against the stored URL (MainActivity)
  ├── wire protocol matches, or server unreachable → Login | Conversations (remember-me)
  └── mismatch → UpdateRequiredScreen (a gate, not a destination)
        ├── "Check for updates" → in-app update
        └── "Change server" → sign out, then Login with the stored URL editable (#150)
Mid-session: HTTP 426 (WireProtocolInterceptor) or WebSocket close 4426 → the same gate
Login → Conversations ("Chats", the start destination; hamburger → app drawer)
  ├── Tap a row / New chat FAB → Chat
  ├── Say the wake word (mic strip) → Chat + auto voice interaction
  ├── Drawer → Chats | Assistant | Personas | Tools & MCP | Skills
  ├── Drawer → Settings → Account | Appearance | TTS & ASR | Face Identities | About
  └── Drawer → Logout
Chat header (persona name) → persona sheet → "Manage personas" → Personas
Chat header (face icon) → character overlay (a sheet, not a destination)
Back everywhere → navController.popBackStack()
```

- The gate is state in `MainActivity`, not a route: a `VersionCheck.Mismatch` renders
  `UpdateRequiredScreen` instead of the `NavHost`. "Change server" calls `AuthRepository.logout()`,
  sets the start destination to `LOGIN` and marks the gate dismissed, so the NavHost mounts on the
  login form; `LoginViewModel` prefills the Server URL from `PreferencesDataStore` and re-caches
  whatever the user submits in `DynamicBaseUrlInterceptor`. The mismatch is not re-checked until
  the next launch — the server the user is about to log in to may be a different one.
- The gate also fires **during** a session. `ProtocolMismatchSignal` (`data/remote/api/`) is a
  singleton `StateFlow<ServerVersionInfo?>`: `WireProtocolInterceptor` sets it from the body of any
  HTTP 426, and `WebSocketManager` sets it on a 4426 close (after asking `GET /version` for the
  numbers, and without reconnecting — a retry cannot fix a protocol mismatch). `MainActivity`
  collects it into `versionCheck = Mismatch(...)`, re-arming the gate; "Change server" clears it.
- `Routes.CONVERSATIONS` = landing page after login: one row per conversation — title, age, last
  message, and nothing about who answers it (#192). `Routes.CHAT` carries **no** nav arguments — the conversation to show is passed through
  `CoreState.setConversationId(...)` before navigating, and `ChatViewModel` picks it up from there.
- The drawer lives in `ui/navigation/AppDrawer.kt` (`AppDrawerHost`), not inside a screen: Chats and
  Chat both open the same one, so the nav graph wraps both destinations in it. Drawer destinations
  `popUpTo(CONVERSATIONS)` rather than stacking. Logout is `AppDrawerViewModel`.
- Chat's outbound navigation is passed in as a lambda, not a `NavController`: `onNavigateToPersonas`
  ("Manage personas" in the persona sheet). It is a plain `navigate(...)` rather than the drawer's
  `openTopLevel`, so system Back returns to the chat the user was in — `openTopLevel` would pop it
  off the stack. "Choose a model" on the no-model prompt navigates nowhere: it opens the header's
  model sheet (`ChatModal.ModelPicker`), which is the only model picker in the app (#197).
- `ConversationsViewModel` observes `CoreState.asrTranscripts` for the assistant's wake word. The
  trigger is assistant-level and selects no persona.
