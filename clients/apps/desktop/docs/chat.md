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
- **Subtitles**: `useTTS` parses WAV header for duration, calls `onPlaybackStart(text, duration)` before each queue item plays. On TTS error, falls back to 4s duration. ChatWidget forwards to character window via IPC.

## Interactive Mode
Two-level state managed by `useMicStore` (Zustand, `@kurisu/state`'s `micStore.ts`): `interactiveMode` (outer) + `interactionActive` (inner substate).

**Typing (default, `interactiveMode: false`)**:
- Mic on → ASR transcript placed into input field as dictation text → user presses Send manually
- Trigger word detection: if transcript contains the assistant's `trigger_word` (case-insensitive), enables interactive mode + activates interaction + auto-sends that transcript. The wake word is assistant-level and selects no persona
- Mic button: red icon when listening, default when idle. No pulse animation.

**Interactive (`interactiveMode: true`)**:
- Entire bottom input area replaced by `InteractiveCallBar` — centered layout with transcript display, large 64px mic button, status text, red Hang Up button
- **Auto mic**: Entering → `startListening()` if idle; exiting → `stopListening()`. Input field cleared on entry.
- **Entry**: Phone toggle in MainWindow top bar, or trigger word match in typing mode
- **Exit conditions**: Hang up button, phone toggle, persona change, conversation change

**Interaction substates within interactive mode**:
- **Idle (`interactionActive: false`)**: Mic listens, transcripts shown visually but NOT sent. Status text: "Waiting for trigger word...". Mic button grey, no pulse ring. Awaiting trigger word to activate.
- **Active (`interactionActive: true`)**: All ASR transcripts auto-send (or queue via `pendingAutoSendRef` if streaming). Status text: "Listening..."/"Processing..."/"Thinking..."/"Speaking...". Mic button primary color with pulse ring animation.
- **Activation**: Trigger word detected in transcript → `activateInteraction()` + auto-send. Sound effect: `start_effect.wav`.
- **Deactivation**: 30s idle after TTS+streaming finish → `deactivateInteraction()` (stays in interactive mode, keeps listening). Sound effect: `stop_effect.wav`.
- **Config**: `assistant.trigger_word` — one wake word for the whole assistant, not per persona. It wakes the assistant; whichever persona the conversation is bound to answers. Managed in the Assistant settings section, stored in the backend DB

## Conversation Management (One Per Persona)
- **Persona list** (`ConversationsPage.tsx`, reached from the ActivityBar): every persona with name, last message preview, and relative timestamp. No avatar — one assistant answers every row through the same default persona, so the face was the same face all the way down (#192). Previews come from `GET /conversations` (includes `last_message`), matched to personas via the localStorage mapping. Refreshed on `loadPersonas()`, `DoneEvent`, and clear conversation.
- Each persona has one conversation, managed via the `kurisu_persona_conversations` localStorage mapping (`Record<string, number>`, persona ID → conversation ID). The `'unbound'` key holds a conversation started while no persona was selected — the client only learns who answered when the first `stream_chunk` carries a `persona_id`.
- Persona selection triggers conversation load (or empty state if no mapping exists)
- **Fallback recovery**: When the localStorage mapping is missing (cleared, new device, etc.), the persona store queries `GET /conversations?persona_id=` for the latest conversation bound to that persona. If found, loads it and restores the mapping. If not, shows empty state (conversation auto-created on first message). The mapping is a cache only — there is no client-side migration of the pre-split keys; `storage.clearLegacyAgentKeys()` just drops them once at startup.
- Backend auto-creates the conversation on first message with `conversationId=null` and silently binds it to `assistant.default_persona_id`; the first `StreamChunkEvent` saves the mapping. There is no new-chat persona picker — the chat header's persona sheet is a per-conversation override that `PATCH /conversations/{id}` persists.
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
- **Token count**: Always visible as "used / cap". Frontend-calculated: `(compacted_context + context_window_messages) * 1.3` word estimate. During streaming, backend `StreamChunkEvent.token_count` overrides
- Store tracks `compactedUpToId`, `compactedContext`, `systemPromptTokenCount` from `GET /conversations/{id}` response. `ContextInfoEvent` updates watermark live after compaction
- Compacted messages: resend disabled (backend blocks deletion too)

## Slash Commands (`@kurisu/state`'s `commands.ts`)
- `/clear`, `/delete`, `/resume`, `/context`, `/persona`, `/refresh`, `/live-animate`, `/vision`, `/compact` (lazy imports to avoid circular deps)
- `/persona` — opens the chat header's persona sheet (`kurisu:open-persona-picker`). A per-conversation override, persisted with `PATCH /conversations/{id}`
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
