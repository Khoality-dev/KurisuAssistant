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
│   ├── local/                   -- DataStore, EncryptedPrefs, StorageKeys, DriveFiles (a picked file, the drive cache, a saved document — #175)
│   ├── remote/api/              -- Retrofit service, interceptors, ProtocolMismatchSignal (live 426 / 4426 → update gate)
│   ├── remote/websocket/        -- OkHttp WebSocket, event payloads, NotificationSocket (/ws/notifications, #353)
│   ├── model/                   -- Data classes (API, WS, Animation, UpdateModels, DriveModels)
│   ├── push/                    -- PushRegistration + FcmTokenSource: this phone's FCM token on the server (#353)
│   └── repository/              -- Auth, Assistant, Persona, Conversation, Calendar, TTS, ASR, Vision, Tools, Face, Update,
│                                   Notification (the server's notifications and their read state, #353), Drive (#175) repos
├── domain/
│   ├── chat/                    -- Stream processor, sentence splitter, narration stripper
│   ├── tts/                     -- TTS queue, WAV parser, amplitude computer
│   ├── audio/                   -- AudioRecorder, VoiceActivityDetector
│   ├── character/               -- Compositor, image cache, animation migration; vrm/: the 3D page's messages, feed, asset resolver
│   ├── calendar/                -- CalendarMath: windows, which day an entry is on, a repeat in words and the key of each of its times (#355), the tool card (#282)
│   ├── drive/                   -- DriveTransfers (every upload and download, one at a time, in the app's scope) and DriveFormat (#175)
│   └── notifications/           -- What a notification says and opens; NotificationSync (what to post and cancel)
├── ui/
│   ├── navigation/              -- NavGraph + AppDrawerHost (routes: LOGIN, CONVERSATIONS, CHAT, TASKS, CALENDAR, DRIVE, ASSISTANT, PERSONAS, TOOLS_MCP, SKILLS, SETTINGS, ACCOUNT, TTS_ASR, APPEARANCE, FACES, ABOUT, NOTIFICATIONS, UNREAD)
│   ├── theme/                   -- Material 3 theme (primary #2563EB)
│   ├── auth/                    -- Login screen + ViewModel
│   ├── conversations/           -- Chats list (start destination) + voice mode strip + in-app update check; a task run's conversation has a clock (#352)
│   ├── tasks/                   -- Tasks (#352): grouped list (waiting for approval first; finished one-offs not listed) with filter chips, a task opened in place with its runs, approve/deny, pause/resume/stop/edit/delete; refetches on `tasks_changed`. `TaskApprovalsViewModel` feeds the chat's approval sheet for a run's conversation
│   ├── chat/                    -- Chat screen, message bubble, tool rail, task card (#352), input with the permission mode chip and sheet (#360), markdown (no nav args)
│   ├── calendar/                -- Calendar screen + ViewModel, the chat's calendar card (#282); a reminder's Repeats in the editor (#355)
│   ├── drive/                   -- Kurisu Drive (#175): a folder at a time, the storage card, row menus, the + menu, the transfer strip and sheet, Move sheet
│   ├── assistant/               -- The one assistant (wake word, thinking, memory, tools)
│   ├── personas/                -- Persona CRUD (name, prompt, voice, avatar) + ViewModel
│   ├── common/                  -- Shared UI bits (personaInitials, ModelDropdown)
│   ├── settings/                -- Settings index + Account, Appearance, Notifications, TTS & ASR, Tools & MCP, Skills screens
│   ├── faces/                   -- Face Identities CRUD (camera capture via TakePicture intent + FileProvider)
│   ├── update/                  -- UpdateDialog composable (in-app update from GitHub Releases)
│   ├── version/                 -- Wire-protocol gate: UpdateRequiredScreen + UpdateRequiredCopy (which side to update)
│   └── character/               -- Character canvas, video player, screen + ViewModel; vrm/: the page's WebView and bridge
├── service/                     -- CoreService (foreground service), CoreState (shared singleton), VoiceInteractionManager,
│                                   KurisuMessagingService (FCM data messages with the app closed, #353), ForegroundNotifications
│                                   (the socket while open), NotificationPoster, tap intents and NotificationNavigation
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
  ├── In voice mode, say the wake word → Chat, in a new conversation (#341)
  ├── Drawer → Chats | Tasks | Calendar | Drive | Assistant | Personas | Tools & MCP | Skills
  ├── Drawer → Settings → Account | Appearance | Notifications | TTS & ASR | Face Identities | About
  ├── Bell (top bar) → Unread → an item → its conversation in Chat (#353)
  ├── Tap a notification → its conversation in Chat (a reminder: Calendar on that entry, #282)
  └── Drawer → Logout
Chat header (model name) → model sheet
Chat ⋮ menu → Live character → character overlay (a sheet, not a destination)
`/persona` → persona sheet → "Manage personas" → Personas
Chat task card → "Open in Tasks" → Tasks with that task open (`tasks?open={id}`)
Tasks → a task's run → Chat, on that run's conversation
A calendar card in the chat → Calendar on that entry (`Routes.calendar(id)`)
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
- `Routes.TASKS` (#352) is a drawer destination; its optional `open` argument opens one task, which
  is how a chat task card's "Open in Tasks" lands on it. A task opens in place (system back closes
  it); opening one of its runs sets the run's conversation on `CoreState` and navigates to the chat,
  as the Chats list does.
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

- `Routes.DRIVE` (#175) is a drawer destination like Chats. A folder opens in place, not as a route: the
  path lives in `DriveViewModel` and system Back goes up one folder until the root, where it leaves. A
  file is handed to another app with `ACTION_VIEW` (or the share sheet) on a `FileProvider` URI under
  the cache's `drive/`; nothing navigates. Transfers belong to the `DriveTransfers` singleton, so leaving
  the screen does not stop one.

- `Routes.CALENDAR` (#282) is a drawer destination like Chats. Its pattern is
  `calendar?reminderId={reminderId}`: `Routes.calendar(id)` opens it on one entry
  — that entry's day, with its sheet open — which is what the chat's calendar card
  uses, through the `LocalOpenCalendar` the nav graph provides around `ChatScreen`,
  and what a reminder notification's tap is for (#353). The screen opens on today's
  day; Week is one tap away. Everything is shown in the phone's zone.
