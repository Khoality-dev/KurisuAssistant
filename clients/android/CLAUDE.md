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
│   ├── navigation/              -- NavGraph with routes (HOME, CHAT/{agentId}, AGENTS, TOOLS, SETTINGS, CHARACTER)
│   ├── theme/                   -- Material 3 theme (primary #2563EB)
│   ├── auth/                    -- Login screen + ViewModel
│   ├── home/                    -- Conversation list + ModalNavigationDrawer (HomeScreen + HomeViewModel)
│   ├── chat/                    -- Chat screen, message bubble, input, markdown (nav arg: agentId, triggerText)
│   ├── agents/                  -- Agent CRUD management (create, edit, delete) + ViewModel
│   ├── settings/                -- Settings screen + ViewModel
│   ├── tools/                   -- Tools & Skills management (3-tab: Servers, Tools, Skills) + ViewModel
│   ├── update/                  -- UpdateDialog composable (in-app update from GitHub Releases)
│   └── character/               -- Character canvas, video player, screen + ViewModel
├── service/                     -- CoreService (foreground service), CoreState (shared singleton), VoiceInteractionManager
└── di/                          -- Hilt modules (App, Network)
```

## Commands

- Build: `./gradlew assembleDebug` (requires `JAVA_HOME` set to Android Studio JBR, e.g. `export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"`)
- Install: `./gradlew installDebug`
- Note: `gradle-wrapper.jar` is gitignored — builds must run from an environment where it has been generated (e.g. Android Studio)

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

### TTS Pipeline
- Sentence boundary splitting (`.!?。！？\n`) → `queueText()` FIFO
- WAV bytes → parse PCM → pre-compute RMS curve → MediaPlayer + amplitude polling

### Voice Interaction
- AudioRecord → Silero VAD (ONNX) → speech detection → ASR → trigger word → interaction mode
- 30s idle timeout after TTS+streaming complete
- **ASR transcript hint**: Every ASR result stored in `CoreServiceState.lastTranscript`, shown as placeholder in ChatInput and in Home MicStatusBar (overwrites on each new result, visible even without trigger word match)

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
