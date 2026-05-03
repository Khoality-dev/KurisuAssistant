# CLAUDE.md

## Project Overview

KurisuAssistant native Android client — Kotlin/Jetpack Compose app that connects to the KurisuAssistant backend. Features streaming chat, TTS with lip sync, Silero VAD voice interaction, character animation, and camera vision pipeline.

## Tech Stack

- **Language**: Kotlin, minSdk 26 (Android 8.0), targetSdk 35
- **UI**: Jetpack Compose + Material 3
- **Navigation**: Compose Navigation (NavHost)
- **HTTP**: Retrofit + OkHttp3 + Kotlin Serialization (trusts self-signed certs)
- **WebSocket**: OkHttp3 WebSocket
- **DI**: Hilt
- **State**: ViewModel + StateFlow + Coroutines
- **Storage**: DataStore Preferences + EncryptedSharedPreferences (JWT)
- **Audio Playback**: MediaPlayer (TTS WAV files)
- **Audio Recording**: AudioRecord (16kHz mono PCM for VAD)
- **VAD**: ONNX Runtime Android + Silero VAD model
- **Camera**: CameraX ImageAnalysis (3 FPS frame capture)
- **Canvas**: Jetpack Compose Canvas (character rendering)
- **Video**: ExoPlayer (Media3) for transition videos
- **Markdown**: Markwon (via AndroidView interop)
- **Image Loading**: Coil

## Project Structure

```
com.kurisu.assistant/
├── KurisuApplication.kt         -- @HiltAndroidApp
├── MainActivity.kt              -- Single activity, NavHost
├── data/
│   ├── local/                   -- DataStore, EncryptedPrefs, StorageKeys
│   ├── remote/api/              -- Retrofit service, interceptors
│   ├── remote/websocket/        -- OkHttp WebSocket, event payloads
│   ├── model/                   -- Data classes (API, WS, Animation, UpdateModels)
│   └── repository/              -- Auth, Agent, Conversation, TTS, ASR, Vision, Tools, Update repos
├── domain/
│   ├── chat/                    -- Stream processor, sentence splitter, narration stripper
│   ├── tts/                     -- TTS queue, WAV parser, amplitude computer
│   ├── audio/                   -- AudioRecorder, VoiceActivityDetector
│   └── character/               -- Compositor, image cache, animation migration
├── ui/
│   ├── navigation/              -- NavGraph with routes (LOGIN, CHAT, ACCOUNT, TTS_ASR, APPEARANCE, PERSONAS, AGENTS, TOOLS_MCP, SKILLS, CHARACTER, FACES)
│   ├── theme/                   -- Material 3 theme (primary #2563EB)
│   ├── auth/                    -- Login screen + ViewModel
│   ├── home/                    -- Conversation list + ModalNavigationDrawer (HomeScreen + HomeViewModel)
│   ├── chat/                    -- Chat screen, message bubble, input, markdown (nav arg: agentId, triggerText)
│   ├── agents/                  -- Agent CRUD management (create, edit, delete) + ViewModel
│   ├── settings/                -- Settings screen + ViewModel
│   ├── tools/                   -- Tools & Skills management (3-tab: Servers, Tools, Skills) + ViewModel
│   ├── faces/                   -- Face Identities CRUD (camera capture via TakePicture intent + FileProvider)
│   ├── update/                  -- UpdateDialog composable (in-app update from GitHub Releases)
│   └── character/               -- Character canvas, video player, screen + ViewModel
├── service/                     -- CoreService (foreground service), CoreState (shared singleton), VoiceInteractionManager
└── di/                          -- Hilt modules (App, Network)
```

## Commands

- Build types × flavors:
  - Flavors: `prod` → applicationId `com.kurisu.assistant` (the GitHub Releases build); `dev` → applicationId `com.kurisu.assistant.dev`, app name "Kurisu Dev". Both can be installed on the same device.
  - Build everything: `./gradlew assemble` — outputs go to `app/build/outputs/apk/<flavor>/<buildType>/kurisu-assistant-<flavor>-<buildType>-<version>.apk`.
  - Day-to-day debugging: `./gradlew assembleDevDebug` / `./gradlew installDevDebug`.
  - Shippable build: `./gradlew assembleProdRelease` (needs `.env` with the release keystore).
  - Old aliases like `./gradlew assembleDebug` no longer exist — use the flavor-qualified task name.
- Requires `JAVA_HOME` set to Android Studio JBR, e.g. `export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"`.
- Unit tests (JVM): `./gradlew :app:testDevDebugUnitTest` — Robolectric + MockK + Turbine + Truth, no emulator needed.
- E2E UI tests (instrumented): `./gradlew :app:connectedDevDebugAndroidTest` — Compose UI tests, needs an emulator/device.
- Local LAN distribution: copy a release APK into `../AndroidLocalDeployment/apks/` and `docker compose up -d` from that directory — phones on the LAN can install from `http://<host-ip>:34822/`.
- Note: `gradle-wrapper.jar` is gitignored — builds must run from an environment where it has been generated (e.g. Android Studio)

## Testing

- **Unit tests** live in `app/src/test/`. Use Robolectric (`@RunWith(AndroidJUnit4::class)`) only when you need a Context; pure logic should stay plain JVM. Existing coverage: `SentenceSplitter`, `NarrationStripper`, `WavParser`, `AmplitudeCurveComputer`, `AnimationMigration`, `ChatStreamProcessor`, `VoiceInteractionManager`, `HomeViewModel`, `SlashCommands`
- **E2E tests** live in `app/src/androidTest/`. Prefer composable-level tests (`createComposeRule()`) with test-owned state over full-Activity tests, unless navigation/Hilt wiring is the thing under test. Existing coverage: `ChatInputTest`
- `ChatStreamProcessor` exposes an `internal var collectDispatcher` so tests can swap the default `Dispatchers.Default` for `UnconfinedTestDispatcher()` — keep this seam when touching that class
- Robolectric **must** be 4.14+ to match `targetSdk = 35`

## Navigation Flow

```
Login → Home (messaging-app style conversation list, hamburger menu → navigation drawer)
  ├── Tap agent row → Chat (with that agent, nav arg agentId)
  ├── Say trigger word (mic FAB) → Chat (agentId + triggerText) + auto voice interaction
  ├── Drawer → Agents (CRUD: create, edit, delete with model/tools/memory)
  ├── Drawer → Tools & Skills (3-tab: MCP Servers, Tools, Skills with CRUD)
  └── Drawer → Settings
Chat (back button) → Home
```

- `Routes.HOME` = landing page after login, shows agents as conversation rows with last message preview
- `Routes.CHAT` = `chat/{agentId}?triggerText={text}`, ChatViewModel reads nav args via SavedStateHandle
- HomeViewModel observes `CoreState.asrTranscripts` to check all agents' trigger words

## Key Patterns

### Streaming Architecture
- `messages` (DB-persisted) + `streamingMessages` (ephemeral) = displayed list
- Same-role chunks accumulate into one bubble; role change → new bubble
- On DoneEvent: `loadConversation()` refreshes from DB, clears streamingMessages
- **No frame separators**: `frame_id` is still on the wire (`Message.frameId`, `ConversationDetail.frames`) but the chat UI does not draw session breaks. Sessions are surfaced as separate conversations via slash commands (matches desktop)
- **Auto-scroll threshold**: `LaunchedEffect(allMessages.size, streamingMessages.size)` only scrolls to bottom when `isNearBottom` (last visible item within 2 of total). User scrolling up to read history is preserved during streaming

### Slash Commands (client-side only)
- Mirrors desktop's `/utils/commands.ts`. Registry lives in `ui/chat/SlashCommand.kt`; intercepted in `ChatViewModel.sendMessage` before reaching `WebSocketManager`. Unknown `/foo` falls through to backend (returns null from parser)
- Autocomplete dropdown rendered in `ChatInput.kt` whenever input starts with `/` — tap a suggestion to fill `"/<name> "`
- Commands: `/clear` (drop current conversation, server creates new on next send — non-destructive), `/delete` (delete current conversation), `/refresh` (reload from DB), `/resume` (modal picker of past conversations from `ConversationRepository.getConversations(agentId)`), `/agents` (modal picker of all agents — switches via `switchAgent` which loads agent's last conversation), `/context` (dialog showing token count + last `ContextInfoEvent` snapshot), `/compact` (`wsManager.sendCompactContext(convId)` → backend responds with `ContextInfoEvent`)
- **Not ported**: desktop's `/vision` (Android does not expose webcam vision toggling) and `/live-animate` (Android exposes the character screen as a chat header button instead — see Character Button below)
- Modal state lives in `ChatUiState.modal: ChatModal?` (sealed: ResumePicker / AgentPicker / ContextDialog). Transient feedback via `ChatUiState.commandFeedback` — auto-cleared after 2.2s by `LaunchedEffect`

### Character Button (live-animate equivalent)
- Replaces desktop's `/live-animate` slash command. Chat header has a `Face` icon button that navigates to `Routes.CHARACTER` (`CharacterScreen`). Plumbed via `ChatScreen.onNavigateToCharacter` callback wired in `NavGraph`

### TTS Pipeline
- Sentence boundary splitting (`.!?。！？\n`) → `queueText()` FIFO
- WAV bytes → parse PCM → pre-compute RMS curve → MediaPlayer + amplitude polling

### Voice Interaction
- AudioRecord → Silero VAD (ONNX) → speech detection → ASR → trigger word → interaction mode
- 30s idle timeout after TTS+streaming complete
- **Always Listen toggle** (`prefs.getAsrAlwaysListen()`, default true): when off, `CoreService` does not auto-start VAD/recording on service start — user must toggle recording manually via mic FAB (aligned with Desktop client's opt-in mic). Settings UI exposes the switch; toggling at runtime calls `CoreService.toggleRecording()` to apply immediately.
- **Dictation drafts**: When an ASR transcript arrives with no trigger word match AND no active interaction mode, `VoiceInteractionManager.handleTranscript()` returns `false`, and `CoreService` emits the text via `CoreState.dictationDrafts`. `ChatViewModel` observes this flow and populates the composer (`inputText`) so the user can edit/send manually — matches Desktop's `pushExternalDraft`. Transcripts matching a trigger word OR during interaction mode still auto-send (unchanged).
- `CoreServiceState.lastTranscript` is still updated for every ASR result and displayed in Home `MicStatusBar`. Chat composer no longer uses it as a placeholder (placeholder is static "Message...").

### CoreService (Unified Foreground Service)
- `CoreService` is the central engine — owns WebSocket, recording, VAD, ASR, chat sending (voice-triggered), TTS wiring, and voice interaction callbacks
- Started on app launch (HomeScreen requests mic permission → starts service). Keeps process alive via persistent notification
- **Owns all callback wiring**: `ChatStreamProcessor` → `TtsQueueManager`, `VoiceInteractionManager` → `sendMessage()`. No dual-ownership with ViewModel
- **VAD loop**: Collects `AudioRecorder.audioChunks` → `VoiceActivityDetector.processSamples()` → speech/silence tracking → `processCurrentRecording()` on 1500ms silence after speech
- **ASR pipeline**: `AudioRecorder.takeAccumulatedPcm()` → `AsrRepository.transcribe()` → `CoreState.emitTranscript()` → `VoiceInteractionManager.handleTranscript()`
- `VoiceInteractionManager` (in `service/`) is a pure interaction-mode state machine (trigger word matching, auto-send, idle timer, sound effects). No audio/VAD/ASR — those live in CoreService
- `CoreState` singleton is the bridge: `CoreServiceState` (isServiceRunning, isRecording, isProcessingAsr, lastTranscript, conversationId, selectedAgentId) + `asrTranscripts` SharedFlow + `streamDone` SharedFlow
- `ChatStreamProcessor` uses internal CoroutineScope (`startCollecting()`/`stopCollecting()`) — survives both Activity and service lifecycles
- **sendMessage in two places**: CoreService handles voice-triggered sends, ChatViewModel handles user-typed sends. Both use the same singletons (`streamProcessor`, `wsManager`). Concurrency guard: both check `streamProcessor.state.value.isStreaming` before sending
- **Stream-done signaling**: CoreService emits `CoreState.streamDone` → ChatViewModel observes, reloads conversation from DB, then clears ephemeral streaming messages

### In-App Update (GitHub Releases)
- `UpdateRepository` uses its own plain `OkHttpClient` (no auth/interceptors) to call GitHub Releases API
- Checks on app launch (HomeViewModel.init) and manually from Settings ("Check for updates" button)
- Compares `tag_name` (semver) against `BuildConfig.VERSION_NAME`
- Downloads APK to `cacheDir/updates/`, installs via FileProvider + `ACTION_VIEW` intent
- `UpdateDialog` composable shows changelog, download progress, and install button
- `REQUEST_INSTALL_PACKAGES` permission + FileProvider declared in manifest
- **Auto-update** (`kurisu_auto_update`, default true): When enabled, `HomeViewModel.checkForUpdate()` immediately calls `downloadAndInstall(autoInstall = true)` after detecting a newer release. The post-download path fires `installApk(application, file)` (in `ui/update/UpdateInstaller.kt`) — the OS still shows the install permission prompt if `REQUEST_INSTALL_PACKAGES` isn't granted. Settings exposes the toggle. When off, the existing 2-step dialog (Update → Install) flow remains

### Character Animation
- 60fps loop via `withFrameNanos`
- Blink FSM, breathing sine wave, mouth amplitude mapping
- Pose tree state machine with AND-logic edge transitions

## Required Assets (user must provide)

- `app/src/main/assets/silero_vad.onnx` — Silero VAD ONNX model (~2MB)
- `app/src/main/res/raw/start_effect.wav` — Voice interaction start sound (optional)
- `app/src/main/res/raw/stop_effect.wav` — Voice interaction stop sound (optional)

## Storage Keys

Same as desktop/mobile clients: `kurisu_auth_token`, `kurisu_remember_me`, `kurisu_selected_model`, `kurisu_backend_url`, `kurisu_tts_backend`, `kurisu_tts_voice`, `kurisu_selected_agent_id`, `kurisu_agent_conversations`, etc.

## Settings Parity (vs Windows Desktop)

The following settings are aligned with the Windows Desktop client (see `data/local/StorageKeys.kt` for the full list):

- **MCP Servers CRUD** — Add/edit/delete dialogs in `ToolsMcpScreen` (FAB + per-card actions). Test button per server. Stdio shows command+args; SSE shows URL. Env vars are KEY=VALUE per line. Delete confirms via dialog
- **ASR Mode** (`kurisu_asr_mode`: "fixed" | "routing"): Fixed shows a single model dropdown (`kurisu_asr_fixed_model`); Routing shows a per-language mapping table (`kurisu_asr_model_map`, JSON-encoded `List<AsrLanguageModelEntry>`). Models populated from `GET /asr/models`
- **Speaker output device** (`kurisu_speaker_device_id`): dropdown listing `AudioManager.GET_DEVICES_OUTPUTS`. `TtsQueueManager.applyPreferredOutput()` reads the pref before each `MediaPlayer.prepare()` and assigns `player.preferredDevice = AudioDeviceInfo` matching the stored id. Empty pref = system default
- **Face Identities** (`Routes.FACES`): list + create dialog (name + camera capture) + detail dialog (photo grid + add/delete photos). Camera via `ActivityResultContracts.TakePicture()` + FileProvider authority `${applicationId}.fileprovider` (cache path `face_photos/`). All endpoints already in `KurisuApiService` — `FaceRepository` is the new wrapper
