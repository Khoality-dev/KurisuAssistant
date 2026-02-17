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
│   ├── model/                   -- Data classes (API, WS, Animation)
│   └── repository/              -- Auth, Agent, Conversation, TTS, ASR, Vision, Tools repos
├── domain/
│   ├── chat/                    -- Stream processor, sentence splitter, narration stripper
│   ├── tts/                     -- TTS queue, WAV parser, amplitude computer
│   ├── voice/                   -- AudioRecorder, VAD, VoiceInteractionManager
│   └── character/               -- Compositor, image cache, animation migration
├── ui/
│   ├── navigation/              -- NavGraph with routes (HOME, CHAT/{agentId}, AGENTS, TOOLS, SETTINGS, CHARACTER)
│   ├── theme/                   -- Material 3 theme (primary #2563EB)
│   ├── auth/                    -- Login screen + ViewModel
│   ├── home/                    -- Messaging-app style conversation list (HomeScreen + HomeViewModel)
│   ├── chat/                    -- Chat screen, message bubble, input, markdown (nav arg: agentId, triggerText)
│   ├── agents/                  -- Agent CRUD management (create, edit, delete) + ViewModel
│   ├── settings/                -- Settings screen + ViewModel
│   ├── tools/                   -- Tools & Skills management (3-tab: Servers, Tools, Skills) + ViewModel
│   └── character/               -- Character canvas, video player, screen + ViewModel
├── service/                     -- ChatForegroundService, ServiceState
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
- HomeViewModel uses `VoiceInteractionManager.onRawTranscript` to check all agents' trigger words

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

### Foreground Service (Background Operation)
- `ChatForegroundService` keeps the process alive via a persistent notification
- Started when voice interaction mode enters; stopped when it exits
- Owns callback wiring (ChatStreamProcessor → TtsQueueManager, VoiceInteractionManager → chat send)
- `ServiceState` singleton shares `conversationId`/`selectedAgentId`/`isServiceRunning` between service and ViewModel
- ChatStreamProcessor uses internal CoroutineScope (`startCollecting()`/`stopCollecting()`) — survives both Activity and service lifecycles
- ViewModel defers callback ownership to service when it's running; re-wires when service stops

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
