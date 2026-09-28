# Chat runtime

[← clients/desktop](../CLAUDE.md)

How a turn behaves on screen: streaming, speech, the voice call mode, and the conversation it belongs to.

## Streaming Architecture (ChatWidget)
- **Store `messages`** = DB-persisted only (never mutated during streaming)
- **`streamingMessages`** = ephemeral local state (user msg + assistant/tool responses during stream)
- Render: `[...displayedMessages, ...streamingMessages]` where `displayedMessages` is filtered by display mode
- Uses WebSocket via `wsManager` (StreamChunkEvent, DoneEvent, ErrorEvent, ContextInfoEvent)
- Same-role chunks accumulated into single bubble; role/persona change → new bubble. `StreamChunkEvent.persona_id`/`persona_name` are set on assistant chunks only and are null on tool chunks, where `name` is the tool label and `tool_kind` ("tool"|"sub_agent") + `duration_ms` are the only source for the sub-agent tag and the call timing
- Display via `requestAnimationFrame` batching
- On DoneEvent: streaming messages merged into store instantly (no flash), background `loadConversation()` after 500ms for DB IDs/metadata
- On Cancel: streaming messages merged into store, late chunks ignored via `cancelledRef`
- **Message queue**: Users can send messages during streaming. Frontend shows queued user bubbles immediately; backend queues the request and processes it after current response finishes. Cancel clears the queue.
- **Reconnect**: Auto-reconnect with exponential backoff (1s→2s→4s...30s cap). On WebSocket 4001 (auth failure), auto-refreshes token via `POST /auth/refresh` then reconnects. Manual reconnect still available via status dot. On `ConnectedEvent` with `chat_active`, loads persisted messages from DB (incremental persistence — each message saved server-side on role boundary) and enters streaming mode.
- Typing indicator: bouncing dots inside bubble before first chunk; "Done" checkmark after
- **Model**: the header names the assistant's model beside the persona. The menu behind it lists `GET /models` grouped by provider; a pick is `PATCH /assistant` `{model_name, provider_type}` — the provider travels with the name — and applies from the next message, for every persona. It is the only model picker in the client (#197).
- **Errors**: `ErrorEvent` normally becomes a red MUI Snackbar (`errorToast`) that hides after six seconds, and the streaming bubbles are dropped. One code is handled apart from the rest: `NO_MODEL_SELECTED` (`WS_ERROR_NO_MODEL_SELECTED` in `@kurisu/models`) means the account has no model chosen yet — a new account always does, because provisioning cannot pick one — so instead of the toast the hook sets `needsModel`, `ChatWidget` renders `NoModelPrompt` above the composer until the user acts, and the **text** of the refused message is pushed back into the composer with `pushExternalDraft` (the server rejected it before saving anything). Only the text: `ChatComposer` has already dropped the attachments and `_doSend` has already cleared the explorer selections, which is why the prompt's copy says so rather than promising the whole message back. "Choose a model" opens the header's model menu in place. Android mirrors this with a bottom sheet off its own header (#149, #197).

## Streaming TTS (Always On)
- TTS always active (no toggle). Accumulates content in buffer; on sentence boundary (`.!?。！？\n`), queues via `useTTS().queueText()`
- Parallel synthesis, sequential FIFO playback
- Flushes buffer on speaker change or DoneEvent; `clearQueue()` on cancel/new send
- Tool messages excluded; the voice comes from the speaking persona — `ttsVoiceRef` follows each assistant chunk's `voice_reference`, so a mid-stream handoff switches voice with the bubble
- Action narration (`*walks over*`) stripped via `stripNarration()` before TTS — preserves `**bold**`
- **Subtitles**: `useTTS` parses WAV header for duration, calls `onPlaybackStart(text, duration)` before each queue item plays. On TTS error, falls back to 4s duration. `useCharacterPanel` publishes them to the character feed, where the inline panel's `SubtitleQueue` shows them and `useCharacterBridgeSync` mirrors them to the window while it is open.

## Voice Mode
Three words, used the same way in the UI, the code and these docs (#253): **voice mode**, the **wake word** and an **interaction**. Nothing here is a "call" or an "interactive mode". The flow as a diagram is in the #253 PR.

State lives in `useMicStore` (`@kurisu/state`'s `micStore.ts`): `voiceMode` (on/off), `interactionActive` (an interaction is running), `userSpeaking` (someone is talking right now: from the VAD's start of speech to its end or misfire) and `problem` (why the mic could not start, until it does).

The UI follows the Claude Design mockup "Kurisu - Voice Mode v1", section 1 (#345). **Android mirrors the model and the UI** (section 3, #341): the same three words, states, problems and copy, and the same storage key, `kurisu_voice_mode`.

- **Voice mode is the only time the mic listens.** It replaced the "Always listen" setting: with voice mode off the mic is off, nothing is heard and there is no dictation into the composer (a transcript still in flight when it goes off is dropped). The chat header's control (`VoiceModeToggle`) turns it on and off: off, a grey headset icon (**Start voice mode**); on, a solid blue pill that says "Voice mode on", or "On" when the chat column is under 480 px (**End voice mode**), with an amber dot while the bar shows a problem. It is shown only where the host can capture the microphone (`capabilities.microphone`: always in Electron, a secure context in a browser). `startVoiceMode()` starts listening, `endVoiceMode()` ends any interaction and stops it. This device remembers it (`kurisu_voice_mode`) and `restoreVoiceMode()` turns it back on when the chat mounts. The Voice settings page stops the mic while it enumerates devices and starts it again only in voice mode. Push-to-talk (Ctrl+Space) is gone with it.
- **The voice bar** (`VoiceModeBar`, a region named "Voice mode") stands in for the composer whenever voice mode is on. Which state it shows is one answer, `voiceBarPhase` in `@kurisu/hooks`: a mic problem first, then no wake word, then outside an interaction **waiting** (Say "<wake word>" to start; nothing is sent until then), and inside one **listening** while someone talks (with the live mic level), **transcribing**, **speaking** while the reply is read aloud, **thinking** while it streams, and otherwise **the window**. The first line says the state, naming who answers while they think and speak; the second is what was last said ("You said …"), kept for the whole interaction (`lastTranscript`). A line along the top edge is faint while waiting, solid through an interaction, and in the window drains over the 30 s from when it opened (`windowStartedAt`), with one line: "Ends soon unless you say something" — no countdown. **End voice mode** is a labelled red outline button with a headset-off icon, in the same place in every state (beside the text, or on its own row when the column is narrow). Ending voice mode brings the composer back and a snackbar in the chat column says "Voice mode is off. The mic isn't listening."
- **Problems** replace the status with what is wrong and the fix. The mic store classifies a failure to start (`classifyMicFailure`): `NotAllowedError`/`SecurityError` is **access blocked** (Try again; the copy says to allow it in the system's privacy settings), `NotFoundError`/`OverconstrainedError`/`NotReadableError` is **no microphone found** (Try again, Voice settings), anything else is **speech recognition didn't load** (Retry). Try again and Retry are `retryListening()`. None of these is a toast any more; a failed transcription still is. **No wake word set** is amber, a setup step: voice mode can start nothing, and the action opens Settings → Assistant, where the wake word is set.
- **The wake word** starts an interaction, and only in voice mode: a transcript containing the assistant's `trigger_word` (anywhere, any case — as Android's `VoiceInteractionManager` hears it; `heardWakeWord` in `useInteractiveASR`). Speech without it is ignored while voice mode waits. The wake word is assistant-level and selects no persona; it lives in `useMicStore().triggerWord`, set by `ChatWidget` from `GET /assistant` and by the Assistant settings on save, so a new one applies without a restart.
- **An interaction** sends everything said, with no wake word again (`start_effect.wav` when it starts). **Each interaction is a new conversation**: the wake word's sentence goes out with `handleSendText(text, { newConversation: true })`, which clears to a new conversation as `/clear` does and sends into it; what follows goes to that conversation. The transcript opens on a marker (`NewInteractionMarker`) saying so, with the time the wake word was heard (`wokeAt`) and, when a conversation was open before, a link to Conversations, where it is kept; `ChatWidget` binds the marker to the new conversation once the server has created it. A persona or conversation change does not end it.
- **It ends** 30 s after the assistant's last reply has finished — streaming and speaking — with nothing said since. Talking, and the transcription after it, hold the window shut; it opens again, full, when they are over, so saying anything refills it. Voice mode stays on and waits for the wake word again (`stop_effect.wav`). The assistant's `app_end_interaction` tool ends it the same way. Turning voice mode off ends it too.

## Conversation Management (One Per Persona, and the Assistant's Own)
- **A persona is optional (#302).** With none, the assistant answers as itself: chunks carry `persona_id: null` and the name `Assistant` (`ASSISTANT_NAME` in `@kurisu/models`), and the header shows "Assistant" with the default icon. The client never fills a persona in on its own — the persona store keeps `selectedPersonaId` null when nothing is chosen (a remembered persona that is gone falls back to null, never to "the first persona"), and a new chat with nothing chosen sends no `persona_id`, so the assistant answers — the server never slips the default persona in (#334). Who the chat is on is the assistant's `selected_persona_id` on the server (#334): `loadPersonas` reads it after sign-in and `selectPersona` writes it, so every device and every sign-in open on the same persona. Until it has loaded, `selectedPersonaId` null means "not known yet" (`selectionLoaded`), and a new chat's first send waits for it (`whenSelectionLoaded`, at most 10 s) — a send that beat the round trip named nobody and the assistant answered.
- **Conversation list** (`ConversationsPage.tsx`, reached from the ActivityBar): an **Assistant** row first, for the assistant's own conversation, then every persona, each with name, last message preview, and relative timestamp. No avatar — the face was the same face all the way down (#192). Previews come from `GET /conversations` (includes `last_message`), matched to rows via the localStorage mapping (`assistantPreview` for the Assistant row). Refreshed on `loadPersonas()`, `DoneEvent`, and clear conversation.
- Each row has one conversation, managed via the `kurisu_persona_conversations` localStorage mapping (`Record<string, number>`, persona ID → conversation ID). The `'unbound'` key is the assistant's own: a conversation started while no persona was chosen stays there when the assistant answers it, and is re-keyed to a persona only if the first `stream_chunk` names one — which the server no longer does for a chat that named nobody (#334), so the conversation stays where a reopen looks for it.
- Selecting a row triggers conversation load (or empty state if no mapping exists)
- **Fallback recovery**: When the localStorage mapping is missing (cleared, new device, etc.), the persona store queries `GET /conversations?persona_id=` for the latest conversation bound to that persona — or, for the Assistant row, the latest answered conversation with `persona_id: null` (`getLatestAssistantConversation`). If found, loads it and restores the mapping. If not, shows empty state (conversation auto-created on first message). The mapping is a cache only — there is no client-side migration of the pre-split keys; `storage.clearLegacyAgentKeys()` just drops them once at startup. Every such lookup is a round trip the user can outrun: whatever it finds — nothing yet, an older conversation, a failure — is dropped if the chat has moved on to a conversation the user's own send started, or another persona was picked (`openBucket` in `@kurisu/state`'s `personaStore.ts`, #321). It used to clear the conversation just started, so the first message vanished and the next one opened a new conversation.
- Backend auto-creates the conversation on first message with `conversationId=null`; a chosen persona goes along as `persona_id`, otherwise the assistant answers (#334). The first `StreamChunkEvent` saves the mapping. There is no new-chat persona picker — the chat header's persona sheet ("Who should answer?"), whose first option is **Assistant** ("No persona — the assistant itself"), marks whoever the chat is on with the **In the chat** chip, a tinted row and a ringed avatar (as Settings → Personas marks it, #348), says the choice is saved to the account, and ends with **Manage personas**, which opens Settings → Personas. A persona without a picture shows the person icon there and in the header; the assistant keeps its robot. Picking is a per-conversation override that `PATCH /conversations/{id}` persists; `persona_id: null` hands the conversation to the assistant, and the conversation leaves the bucket it was in.
- "Clear conversation" button deletes via API + removes mapping entry
- Mapping cleared on logout (`clearAllPersonaConversations`) and persona delete (`clearPersonaConversationId`)

## Image Handling
- Upload: base64 images sent in `chat_request` WebSocket event → backend saves to per-user directory, returns UUIDs via `StreamChunkEvent.images`
- Display: `message.images[]` UUIDs rendered via `apiClient.getUserImageUrl(uuid)` → `GET /images/u/{uuid}?token=` (auth-required, per-user scoped)
- Streaming: `StreamChunkEvent.images` merged into current streaming message's images array
- Tool images: MCP tools returning `ImageContent` produce image UUIDs streamed on tool-role chunks
- Avatars and face photos: `apiClient.getImageUrl(uuid)` → `GET /images/{uuid}?token=` — **not public since #154**, and served only to the account that owns the image. Same query-param token as the per-user route above, for the same reason: these go into `<img src>`. A UUID belonging to someone else answers 404.

## Display Modes & Token Usage
- **All Messages** (default): Full conversation history across all frames, paginated on scroll-up
- **Context Window**: Only messages after compaction watermark (`id > compactedUpToId`) + collapsible compacted context summary banner
- Toggle via `ToggleButtonGroup` above messages pane; scrolls to bottom on switch
- **Context use**: always visible in the chat header as a small bar (`ContextUsageBar`) — the share of the context used, orange past 80% and red past 90%, with the percentage on hover; the exact counts are in the context breakdown it sits beside (#343). Frontend-calculated: `(compacted_context + context_window_messages) * 1.3` word estimate. During streaming, backend `StreamChunkEvent.token_count` overrides
- Store tracks `compactedUpToId`, `compactedContext`, `systemPromptTokenCount` from `GET /conversations/{id}` response. `ContextInfoEvent` updates watermark live after compaction
- Compacted messages: resend disabled (backend blocks deletion too)

## Slash Commands (`@kurisu/state`'s `commands.ts`)
- `/clear`, `/delete`, `/resume`, `/context`, `/persona`, `/refresh`, `/live-animate`, `/vision`, `/compact` (lazy imports to avoid circular deps)
- `/live-animate` — shows or hides the character, like the Face icon on the chat header: the inline panel on every host, or the window if it is popped out (#241). Before the panel it needed `capabilities.characterWindow` and answered "This host has no character window." in a browser (#237)
- `/persona` — opens the chat header's persona sheet (`kurisu:open-persona-picker`). A per-conversation override, persisted with `PATCH /conversations/{id}`
- `/resume` — opens the conversation picker for the chosen persona, or with none chosen the assistant's own conversations (`persona_id: null`); it no longer refuses without a persona (#302)
- `/compact` — compact conversation context (sends `compact_context` WebSocket event). The backend answers `context_info` twice, `compacting: true` then `compacting: false` carrying the summary and the new watermark, and compacts **in place**: same conversation, same id, same transcript on screen. `useStreamingChat` records the watermark and reloads the conversation. It used to fork into a new conversation announced by `conversation_switched`; that event is gone (#99)
- `/clear` — start a new empty conversation + clear the persona mapping entry
- Autocomplete dropdown in `ChatComposer`: filtered on `/` prefix, Enter auto-selects first match, closes dropdown after selection
- All `/`-prefixed input intercepted client-side, never sent to backend
- Commands return feedback strings shown as info toasts
- `handleCommand()` is async, returns `Promise<string | null>`

## Composer scope
- `ChatComposer` takes `personaId` and `conversationId` (both nullable) rather than a string key. Both resolve asynchronously after login — the persona store settles, the latest conversation loads — and a draft typed in that window must survive it.
- The scope effect clears `input` and `images` only when **leaving a concrete scope**: the previous persona was bound *and* the previous conversation had an id, and either changed. `null → id` is the scope becoming known, not a switch, so the draft stays. Before this the effect cleared on any change, which lost real keystrokes and is what left the e2e composer disabled right after `fill()` on Windows CI (#145).
- Prompt history is repopulated from the store's messages on every scope change, as before.

## Prompt History
- Session-scoped prompt history tracked in `ChatComposer` via `promptHistoryRef`
- Arrow Up: browse previous prompts (saves current draft in `draftRef`)
- Arrow Down: browse forward or return to draft
- Only active when command dropdown is closed

## Keyboard Shortcuts
- **Esc**: Cancel streaming (only during active stream)
- **Enter**: Send message (or select command if dropdown open)
- **Shift+Enter**: Newline
- **Arrow Up/Down**: Prompt history (or command dropdown navigation)
- **Tab**: Select command in dropdown

## Pagination
- 20 messages/page, newest first. Scroll to top triggers `loadMoreMessages()`. Position preserved. Loading indicator hidden in Context display mode.
