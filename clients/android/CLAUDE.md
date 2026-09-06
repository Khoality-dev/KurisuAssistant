# CLAUDE.md

## Project Overview

`clients/android/` in the KurisuAssistant monorepo (see the root `CLAUDE.md`; the backend is in `../../backend/`). KurisuAssistant native Android client — Kotlin/Jetpack Compose app that connects to the KurisuAssistant backend. Features streaming chat, TTS with lip sync, Silero VAD voice interaction, character animation, and camera vision pipeline.

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

## Documentation Index

- [Architecture](docs/architecture.md) — package layout and the navigation flow between screens
- [Runtime patterns](docs/patterns.md) — streaming, slash commands, TTS, voice interaction, CoreService, QR login, in-app update, character animation
- [Screens](docs/screens.md) — screenshots and how they are captured

**These documents are part of the code.** A change that makes one of them wrong is not finished: update it in the same commit.

## Commands

- Build types × flavors:
  - Flavors: `prod` → applicationId `com.kurisu.assistant` (the GitHub Releases build); `dev` → applicationId `com.kurisu.assistant.dev`, app name "Kurisu Dev". Both can be installed on the same device.
  - Build everything: `./gradlew assemble` — outputs go to `app/build/outputs/apk/<flavor>/<buildType>/kurisu-assistant-<flavor>-<buildType>-<version>.apk`.
  - Day-to-day debugging: `./gradlew assembleDevDebug` / `./gradlew installDevDebug`.
  - Shippable build: `./gradlew assembleProdRelease` (needs `.env` with the release keystore).
  - Old aliases like `./gradlew assembleDebug` no longer exist — use the flavor-qualified task name.
- Requires `JAVA_HOME` set to Android Studio JBR, e.g. `export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"`.
- Unit tests (JVM): `./gradlew :app:testDevDebugUnitTest` — Robolectric + MockK + Turbine + Truth, no emulator needed.
- E2E UI tests (instrumented): `./gradlew :app:connectedDevDebugAndroidTest` — Compose UI tests, needs an emulator/device **and the mock backend running**: `npm run mock:backend -- --host 0.0.0.0 --port 15597` from `clients/desktop` (#126). The dev flavour's `BuildConfig.MOCK_BACKEND_URL` is where the suite expects it, `http://10.0.2.2:15597` — the emulator's route to the host — overridable with `-PmockBackendUrl=http://...`.
- Local LAN distribution: copy a release APK into `../../../AndroidLocalDeployment/apks/` (a sibling of the monorepo checkout) and `docker compose up -d` from that directory — phones on the LAN can install from `http://<host-ip>:34822/`.
- Prod release: bump `versionCode`/`versionName`, commit, then push tag `android-v<versionName>`. The root `.github/workflows/android-release.yml` builds `assembleProdRelease` and publishes it as release `v<versionName>` on the legacy `Khoality-dev/KurisuAssistant-Client-Android` repo, which is where `UpdateRepository` checks for updates — keep that URL unchanged unless the update channel is migrated too.

## Testing

- **Unit tests** live in `app/src/test/`. Use Robolectric (`@RunWith(AndroidJUnit4::class)`) only when you need a Context; pure logic should stay plain JVM. Existing coverage: `SentenceSplitter`, `NarrationStripper`, `WavParser`, `AmplitudeCurveComputer`, `AnimationMigration`, `ChatStreamProcessor` (including the `NO_MODEL_SELECTED` code reaching `StreamingState`), `WebSocketManager`, `VoiceInteractionManager`, `VoiceCountdown`, `ConversationsViewModel`, `AssistantViewModel`, `PersonasViewModel`, `ChatViewModel` (persona override), `ToolRailModel`, `SlashCommands`, `PatchBody`, `UpdateRequiredCopy`, `WireProtocolInterceptor` (426 body → `ProtocolMismatchSignal`)
- **E2E tests** live in `app/src/androidTest/`. Prefer composable-level tests (`createComposeRule()`) with test-owned state over full-Activity tests, unless navigation/Hilt wiring is the thing under test. Existing coverage: `ChatInputTest` (composable-level), `e2e/MockBackendChatTest` (the real app against the standalone mock: login → New chat → `chat_request` → stream → `done` in the transcript, and the header's per-conversation persona switch, both read back from the mock over HTTP). It assumes the mock's `default` scenario. The assistant's reply is rendered by Markwon inside an `AndroidView`, which Compose semantics cannot see, so that one assertion goes through Espresso. Three things this suite needed that the project had never set: `testInstrumentationRunner` (AGP's fallback is the pre-AndroidX runner, which crashes before any test — the instrumented suite had never actually run), `packaging` excludes for mockk-android's JUnit 5 licence files, and the AndroidX test orchestrator with `clearPackageData` — the voice service and the per-persona conversation cache are process-wide, and without a fresh process per test the second full-app test inherits the first one's conversation. Material3's extended FAB puts its label under `clearAndSetSemantics`, so "New chat" is only findable with `useUnmergedTree = true`.
- **Client tests — unit, e2e, instrumented, screenshot capture — run against the mock backend, never against a deployed one. The mock mirrors `backend/kurisuassistant/`; when the two disagree, the backend wins and the mock is fixed in the same PR as the protocol change.** There is no backend double on the Android side by design: the desktop package's `tests/mock/server.ts` is the shared one (#126).
- `ChatStreamProcessor` exposes an `internal var collectDispatcher` so tests can swap the default `Dispatchers.Default` for `UnconfinedTestDispatcher()` — keep this seam when touching that class
- Robolectric **must** be 4.14+ to match `targetSdk = 35`

## Required Assets (user must provide)

- `app/src/main/assets/silero_vad.onnx` — Silero VAD ONNX model (~2MB)
- `app/src/main/res/raw/start_effect.wav` — Voice interaction start sound (optional)
- `app/src/main/res/raw/stop_effect.wav` — Voice interaction stop sound (optional)

## Storage Keys

Same as desktop/mobile clients: `kurisu_auth_token`, `kurisu_remember_me`, `kurisu_selected_model`, `kurisu_backend_url`, `kurisu_tts_backend`, `kurisu_tts_voice`, `kurisu_persona_conversations`, etc.

`kurisu_selected_agent_id` was **deleted** in wire protocol 4: there is one assistant, so there is nothing to select locally, and the default persona lives on the assistant row server-side. `kurisu_agent_conversations` became `kurisu_persona_conversations` with no client-side migration — it is a cache that re-derives from the backend on a miss.

## Images are authenticated

`GET /images/{uuid}` stopped being public in #154 — it serves account avatars,
persona avatars and face photos, and now returns them only to the account that
owns them. **This client needed no change**, and the reason is worth protecting:
`KurisuApplication` implements `ImageLoaderFactory` and builds Coil's
`ImageLoader` on the injected `OkHttpClient`, which carries `AuthInterceptor` —
so every image request already sends `Authorization: Bearer …`, and a 401 even
triggers the same refresh-and-retry as an API call.

If Coil is ever given its own `OkHttpClient`, or an image is fetched with a bare
client, avatars go blank. The desktop client cannot do this — a browser `<img>`
tag cannot set a header — so it puts the token in the query string instead.

## Settings Parity (vs Windows Desktop)

The following settings are aligned with the Windows Desktop client (see `data/local/StorageKeys.kt` for the full list):

- **No model chosen yet** — a new account's first message is refused by the server with `NO_MODEL_SELECTED`, and both clients answer it with a prompt onto the model picker rather than an error (#149). Here that is the chat banner turning `secondaryContainer` and offering "Choose a model" → `Routes.ASSISTANT`; on desktop it is a bar above the composer offering Settings → Assistant. **The path differs and the copy must not be shared**: Assistant is a top-level drawer entry on Android and a Settings row on desktop
- **Update gate is not a dead end** — both clients answer a wire-protocol mismatch with a screen that names which side to update and offers "Change server": sign out, back to the login form with the server URL editable (#150). Here it is `ui/version/UpdateRequiredScreen` rendered by `MainActivity` in place of the `NavHost`, and a live HTTP 426 or WebSocket 4426 raises it too via `ProtocolMismatchSignal`; on desktop the same control sits on `UpdateRequiredScreen.tsx` and the axios interceptor handles 426
- **MCP Servers CRUD** — Add/edit/delete dialogs in `ToolsMcpScreen` (FAB + per-card actions). Test button per server. Stdio shows command+args; SSE shows URL. Env vars are KEY=VALUE per line. Delete confirms via dialog
- **ASR Mode** (`kurisu_asr_mode`: "fixed" | "routing"): Fixed shows a single model dropdown (`kurisu_asr_fixed_model`); Routing shows a per-language mapping table (`kurisu_asr_model_map`, JSON-encoded `List<AsrLanguageModelEntry>`). Models populated from `GET /asr/models`
- **Speaker output device** (`kurisu_speaker_device_id`): dropdown listing `AudioManager.GET_DEVICES_OUTPUTS`. `TtsQueueManager.applyPreferredOutput()` reads the pref before each `MediaPlayer.prepare()` and assigns `player.preferredDevice = AudioDeviceInfo` matching the stored id. Empty pref = system default
- **Face Identities** (`Routes.FACES`): list + create dialog (name + camera capture) + detail dialog (photo grid + add/delete photos). Camera via `ActivityResultContracts.TakePicture()` + FileProvider authority `${applicationId}.fileprovider` (cache path `face_photos/`). All endpoints already in `KurisuApiService` — `FaceRepository` is the new wrapper
