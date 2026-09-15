# Runtime patterns

[← clients/android](../CLAUDE.md)

How a turn behaves: streaming, speech, the foreground service that keeps it
alive, and the pieces that must stay in step with the desktop client.

## Streaming Architecture
- `messages` (DB-persisted) + `streamingMessages` (ephemeral) = displayed list
- Same-role chunks accumulate into one bubble; role change → new bubble
- On DoneEvent: `loadConversation()` refreshes from DB, clears streamingMessages
- **No frame separators**: `frame_id` is still on the wire (`Message.frameId`, `ConversationDetail.frames`) but the chat UI does not draw session breaks. Sessions are surfaced as separate conversations via slash commands (matches desktop)
- **Auto-scroll threshold**: `LaunchedEffect(allMessages.size, streamingMessages.size)` only scrolls to bottom when `isNearBottom` (last visible item within 2 of total). User scrolling up to read history is preserved during streaming
- **Errors carry a code, and one of them is not an error.** `ChatStreamProcessor.handleError` puts both the sentence and `ErrorEvent.code` on `StreamingState` (`streamError` / `streamErrorCode`; `WsErrorCodes` in `data/model/WebSocketModels.kt` names the ones this client acts on). `CONNECTION_LOST` is swallowed — the reconnect owns it. `NO_MODEL_SELECTED` means the account has never had a model chosen, which every new account is, so the banner switches from `errorContainer` to `secondaryContainer` and grows a "Choose a model" button that opens the chat header's model sheet in place (`ChatViewModel.openModelSheet`, #197) — the user never leaves the message they were sending — and `ChatViewModel` puts the refused message back in `inputText` — the server rejected it before saving anything (#149). Anything else is the ordinary red banner. **Desktop mirrors this** with a model menu on its own header; neither client navigates away

## Slash Commands (client-side only)
- Mirrors desktop's `/utils/commands.ts`. Registry lives in `ui/chat/SlashCommand.kt`; intercepted in `ChatViewModel.sendMessage` before reaching `WebSocketManager`. Unknown `/foo` falls through to backend (returns null from parser)
- Autocomplete dropdown rendered in `ChatInput.kt` whenever input starts with `/` — tap a suggestion to fill `"/<name> "`
- Commands: `/clear` (drop current conversation, server creates new on next send — non-destructive), `/delete` (delete current conversation), `/refresh` (reload from DB), `/resume` (modal picker of past conversations from `ConversationRepository.getConversations(agentId)`), `/persona` (modal picker of personas — rebinds THIS conversation via `PATCH /conversations/{id}` and does not touch `default_persona_id`), `/context` (dialog showing token count + last `ContextInfoEvent` snapshot), `/compact` (`wsManager.sendCompactContext(convId)` → the backend answers `ContextInfoEvent` twice, `compacting = true` then `false` with the summary and the new watermark, and compacts in place — the conversation keeps its id, so `CoreService` no longer has a switched conversation to adopt (#99))
- **Not ported**: desktop's `/vision` (Android does not expose webcam vision toggling) and `/live-animate` (Android exposes the character screen as a chat header button instead — see Character Button below)
- Modal state lives in `ChatUiState.modal: ChatModal?` (sealed: ResumePicker / PersonaPicker / ContextDialog). Transient feedback via `ChatUiState.commandFeedback` — auto-cleared after 2.2s by `LaunchedEffect`

## Character Button (live-animate equivalent)
- Replaces desktop's `/live-animate` slash command. Chat header has a `Face` icon button that opens `CharacterSheet` (`ui/character/CharacterSheet.kt`) over the transcript. It is a sheet, not a route: the chat keeps streaming behind it, and the sheet is bound to the conversation's persona (falling back to the assistant's default)

## TTS Pipeline
- Sentence boundary splitting (`.!?。！？\n`) → `queueText()` FIFO — only while "Generate TTS during responses" (`prefs.getTTSAutoPlay()`) is on; `CoreService` checks it per sentence. The persona preview ("Hello. This is …") calls `queueText` directly and is not gated
- The request names a `provider` only when the user chose one: `resolveTtsBackend()` turns a blank setting into null and the server's default TTS model answers. It used to fall back to `gpt-sovits`, which is not normally running, so a fresh install was silent (#200). The Settings list comes from `GET /tts/models` (`TtsRepository.listBackends()`); `/tts/backends` never existed on the server
- WAV bytes → parse PCM → pre-compute RMS curve → MediaPlayer + amplitude polling
- A sentence that cannot be synthesized or played goes to `TtsQueueManager.onError` → `CoreState.speechErrors` → the chat's error banner (`ChatViewModel` → `streamProcessor.setError`), as one line built by `describeSpeechFailure()` from the API's `detail`

## Voice Interaction
- AudioRecord → Silero VAD (ONNX) → speech detection → ASR → trigger word → interaction mode
- 30s idle timeout after TTS+streaming complete
- **Always Listen toggle** (`prefs.getAsrAlwaysListen()`, default true): when off, `CoreService` does not auto-start VAD/recording on service start — user must toggle recording manually via mic FAB (aligned with Desktop client's opt-in mic). Settings UI exposes the switch; toggling at runtime calls `CoreService.toggleRecording()` to apply immediately.
- **Dictation drafts**: When an ASR transcript arrives with no trigger word match AND no active interaction mode, `VoiceInteractionManager.handleTranscript()` returns `false`, and `CoreService` emits the text via `CoreState.dictationDrafts`. `ChatViewModel` observes this flow and populates the composer (`inputText`) so the user can edit/send manually — matches Desktop's `pushExternalDraft`. Transcripts matching a trigger word OR during interaction mode still auto-send (unchanged).
- `CoreServiceState.lastTranscript` is still updated for every ASR result and displayed in Home `MicStatusBar`. Chat composer no longer uses it as a placeholder (placeholder is static "Message...").

## CoreService (Unified Foreground Service)
- `CoreService` is the central engine — owns WebSocket, recording, VAD, ASR, chat sending (voice-triggered), TTS wiring, and voice interaction callbacks
- Started on app launch (ConversationsScreen requests mic permission → starts service). Keeps process alive via persistent notification
- **Owns all callback wiring**: `ChatStreamProcessor` → `TtsQueueManager`, `VoiceInteractionManager` → `sendMessage()`. No dual-ownership with ViewModel
- **VAD loop**: Collects `AudioRecorder.audioChunks` → `VoiceActivityDetector.processSamples()` → speech/silence tracking → `processCurrentRecording()` on 1500ms silence after speech
- **ASR pipeline**: `AudioRecorder.takeAccumulatedPcm()` → `chooseAsrModel()` → `AsrRepository.transcribe(language, model)` → `CoreState.emitTranscript()` → `VoiceInteractionManager.handleTranscript()`. The model comes from the Speech settings through the pure `domain/audio/AsrModelSelection`: the fixed model, or in routing mode `AsrRepository.detectLanguage()` first and the per-language table; null is the server default. A failed transcription is one line on `CoreState.speechErrors`, shown in the chat banner (#200)
- `VoiceInteractionManager` (in `service/`) is a pure interaction-mode state machine (trigger word matching, auto-send, idle timer, sound effects). No audio/VAD/ASR — those live in CoreService
- `CoreState` singleton is the bridge: `CoreServiceState` (isServiceRunning, isRecording, isProcessingAsr, lastTranscript, conversationId, selectedAgentId) + `asrTranscripts` SharedFlow + `streamDone` SharedFlow
- `ChatStreamProcessor` uses internal CoroutineScope (`startCollecting()`/`stopCollecting()`) — survives both Activity and service lifecycles
- **sendMessage in two places**: CoreService handles voice-triggered sends, ChatViewModel handles user-typed sends. Both use the same singletons (`streamProcessor`, `wsManager`). Concurrency guard: both check `streamProcessor.state.value.isStreaming` before sending
- **Stream-done signaling**: CoreService emits `CoreState.streamDone` → ChatViewModel observes, reloads conversation from DB, then clears ephemeral streaming messages

## QR Code Login
- LoginScreen has a "Sign in with QR code" button (visible in Login mode only) that opens `QrLoginScanner` in a fullscreen Dialog. CameraX `ImageAnalysis` feeds frames to ML Kit `BarcodeScanning` (bundled flavour, no Play Services dep). On the first decoded payload, `LoginViewModel.applyLoginQr()` parses it, fills the form, and auto-submits.
- Shared payload format (must match Desktop generator): `{"v":1,"server":"https://...","username":"foo","password":"bar"}`. `v` is the schema version. Unknown fields are ignored. Bad payloads surface via `state.error` snackbar.
- Camera permission is requested inline in the scanner overlay — no extra manifest entry beyond the existing `CAMERA` permission used by face capture.

## In-App Update (GitHub Releases)
- `UpdateRepository` uses its own plain `OkHttpClient` (no auth/interceptors) to call GitHub Releases API
- Checks on app launch (`ConversationsViewModel.init`) and manually from Settings → "Check for updates" (or About)
- Compares `tag_name` (semver) against `BuildConfig.VERSION_NAME`
- Downloads APK to `cacheDir/updates/`, installs via FileProvider + `ACTION_VIEW` intent
- `UpdateDialog` composable shows changelog, download progress, and install button
- `REQUEST_INSTALL_PACKAGES` permission + FileProvider declared in manifest
- **Wire-protocol gate** (`ui/version/`): `MainActivity` hits `GET /version` first and, on a mismatch with `BuildConfig.WIRE_PROTOCOL`, shows `UpdateRequiredScreen` instead of the nav graph. `UpdateRequiredCopy.explain(client, server)` produces the sentence and names the side to update — a newer server means "update the app", an older one "ask the operator to update the server" — and is unit-tested. Two ways out: "Check for updates" (the flow above, without the dialog) and "Change server", which signs out and lands on the login form with the stored URL editable (#150). The same screen is raised mid-session through `ProtocolMismatchSignal`: `WireProtocolInterceptor` parses the backend's 426 body (`server_wire_protocol`, `backend_version`; an unreadable body yields wire `-1`, which the copy reports as "the server refused it without saying which it speaks"), and `WebSocketManager` treats close code 4426 the same way, fetching `GET /version` for the numbers instead of reconnecting
- **Auto-update** (`kurisu_auto_update`, default true): When enabled, `ConversationsViewModel.checkForUpdate()` immediately calls `downloadAndInstall(autoInstall = true)` after detecting a newer release. The post-download path fires `installApk(application, file)` (in `ui/update/UpdateInstaller.kt`) — the OS still shows the install permission prompt if `REQUEST_INSTALL_PACKAGES` isn't granted. Settings exposes the toggle. When off, the existing 2-step dialog (Update → Install) flow remains

## Character Animation
- 60fps loop via `withFrameNanos`
- Blink FSM, breathing sine wave, mouth amplitude mapping
- Pose tree state machine with AND-logic edge transitions

## Vision frames are binary

`VisionRepository` compresses each CameraX frame to JPEG and hands the bytes to
`WebSocketManager.sendVisionFrame`, which sends a WebSocket **binary** message
built by `BinaryFrameCodec` — `[version][type][header length][JSON header][JPEG]`.
It was base64 inside a JSON event until wire protocol 6, which inflated every
frame by a third and put the pixels in front of the assistant's next token on the
same socket (#111). `vision_start` and `vision_stop` are still JSON. The format
mirrors `backend/kurisuassistant/websocket/binary.py`; if the two disagree, the
backend wins.
