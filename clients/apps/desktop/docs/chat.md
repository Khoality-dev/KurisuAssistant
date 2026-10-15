# Chat runtime

[← clients/desktop](../CLAUDE.md)

How a turn behaves on screen: streaming, speech, the voice call mode, and the conversation it belongs to.

## Streaming Architecture (ChatWidget)
- **Store `messages`** = DB-persisted only (never mutated during streaming)
- **`streamingMessages`** = ephemeral local state (user msg + assistant/tool responses during stream)
- Render: `[...displayedMessages, ...streamingMessages]` where `displayedMessages` is filtered by display mode
- Uses WebSocket via `wsManager` (StreamChunkEvent, DoneEvent, ErrorEvent, ContextInfoEvent)
- A task tool's result (`task_start`, `task_schedule`, `task_update`, `task_stop`, `task_delete`) is JSON the chat renders as a card instead of a collapsed tool bubble (`TaskResultCard`, `parseTaskToolResult` in `@kurisu/models`, #352): what was started or scheduled, its schedule and next run, "Open in Tasks", and Stop while a started task runs. Anything else, an error included, stays an ordinary tool bubble.
- A task run's conversation may be waiting on the user to approve a call (#352). No live turn is attached, so `ChatWidget` takes it from `tasksStore.approvalForConversation` and shows the usual `ToolApprovalBar`; the answer goes over REST (`POST /tasks/approvals/{id}`), "Always allow/deny" also stores the tool policy.
- Same-role chunks accumulated into single bubble; role/persona change → new bubble. `StreamChunkEvent.persona_id`/`persona_name` are set on assistant chunks only and are null on tool chunks, where `name` is the tool label and `tool_kind` ("tool"|"sub_agent") + `duration_ms` are the only source for the sub-agent tag and the call timing
- **Calendar tool rows** (#282): a `calendar_create`, `calendar_move` or `calendar_delete` row that succeeded is drawn as `CalendarToolCard` under its header — shown whether or not the row is expanded — from the tool's JSON answer (`parseCalendarToolResult` in `@kurisu/models`): what went on the calendar and when, Open in Calendar (`useCalendarStore.openEntry`) and, for something just added, Undo (deletes it). Android draws the same card in its tool rail
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

## Notifications

The assistant and calendar reminders reach this computer with the window closed (#353). **The server keeps every notification and whether it has been read; this client only displays them.** Closing the window hides it to the tray (`electron/main.ts`), so the renderer keeps running and keeps `@kurisu/api`'s `notificationSocket` open on `/ws/notifications` — a socket of its own, because the chat's is last-one-wins and the phone holds one too. `startNotifications()` (`@kurisu/state`'s `notificationStore.ts`, mounted by `MainLayout` for a signed-in session) hands each notification to the host by its server id: the bridge's `notifications.show` → `electron/notifications.ts` → an OS `Notification` titled `<sender> · <title>` (`notificationHeading` in `@kurisu/models`).

- **On every connect** the server sends what is unread (`notifications_ready`). The device shows the ones it has not shown yet and takes down the ones it showed that are no longer unread — read on another device while this one was away. Which ones it has shown is the only notification state the client keeps (`kurisu_notifications_shown`, per server), besides the switch.
- **Reading is the server's to record.** A click on a system notification brings the window forward and sends `notifications:open` with its id and target; the store reads it (`POST /notifications/{id}/read`) and opens it — a conversation is loaded into the chat panel, a calendar reminder is left as `calendarRequest` for the calendar (#282), which reads what points at a reminder with `markNotificationsReadFor({ reminder_id })` when it opens one. Opening a conversation any other way reads what points at it (`/read-for`) — asked only when an unread notification does.
- **The bell** (`@kurisu/ui`'s `notifications/NotificationBell.tsx`, on the activity bar right below the pages) shows the server's unread count as a badge and opens the unread list in a popover with "Mark all read"; opening an item reads it and goes where it points. The list and count are the server's (`GET /notifications?unread=true&limit=50`, into `unread` / `unreadCount`), fetched when listening starts, after every `notifications_ready` / `notification` / `notifications_read`, and when the bell is opened — so a read on the phone clears the badge here.
- **A read on any device takes it down everywhere**: the server sends `notifications_read` with the ids, and the store closes those OS notifications (`notifications:close`) and drops them from the list.

Settings → Notifications is one switch for this computer (`kurisu_notifications_enabled`, on until turned off) and the "Notification sources" list. It is listed only where the host can show OS notifications (`capabilities.systemNotifications`). Off closes the socket. `notify_user` runs without an approval prompt — it is allowed by default (`backend/docs/tools.md`) — and Settings → Tools & MCP shows a Permission switch for it in the tool's details (`ToolPermissionSwitch`): off stores a `deny`, on removes it. **Android mirrors this** with background delivery, the bell on Chats and the same screen for the phone (`clients/android/docs/patterns.md`).

## Conversations and the Persona in Use
- **One persona, or none, is in use for the whole account (#354).** It is the assistant's `selected_persona_id` on the server: `loadPersonas` reads it after sign-in and `selectPersona` writes it (`PATCH /assistant`), and the server answers every turn, in every conversation and on every device, as it. A conversation carries no persona and a `chat_request` names none, so a send that beats `GET /assistant` has nothing to wait for. `selectPersona` keeps the open conversation open — it carries on as the new persona — and a save the server refuses puts the previous one back and surfaces the error in the sheet.
- **A persona is optional (#302).** With none in use, the assistant answers as itself: chunks carry `persona_id: null` and the name `Assistant` (`ASSISTANT_NAME` in `@kurisu/models`), and the header shows "Assistant" with the default icon. The client never fills a persona in on its own — a selection whose persona is gone falls back to null, never to "the first persona".
- **Who spoke stays on the message.** `persona_id` and the embedded `persona` on a stored assistant message, and `persona_id`/`persona_name` on an assistant `stream_chunk`, say who produced it: the bubble's name and avatar and the character panel read them, so an old answer keeps the persona that gave it after a switch.
- **Conversation list** (`ConversationsPage.tsx`, reached from the ActivityBar): the account's conversations from `GET /conversations`, newest first — title, last message preview and relative time, no persona per row (#178, #354). It reads the list again when the open conversation changes or grows, searches titles and previews, and **New chat** clears the open conversation (as `/clear` does). Selecting a row loads that conversation into the chat panel beside it.
- **On sign-in** `MainLayout` calls `loadPersonas` and `openLatestConversation`, which opens the newest conversation `GET /conversations` lists, whichever persona answered it, or none. It is a round trip the user can outrun: whatever it finds — nothing yet, an older conversation, a failure — is dropped if the chat has moved on to a conversation the user's own send started (#321). It used to clear the conversation just started, so the first message vanished and the next one opened a new conversation. `loadPersonas` alone touches no conversation, because Settings → Personas calls it after every edit.
- Backend auto-creates the conversation on first message with `conversationId=null`, titled after that message. There is no new-chat persona picker — the chat header's persona sheet ("Persona in use"), whose first option is **Assistant** ("No persona — the assistant itself"), marks the persona in use with the **In use** chip, a tinted row and a ringed avatar (as Settings → Personas marks it, #348), says the choice is saved to the account and applies to every conversation, and ends with **Manage personas**, which opens Settings → Personas. A persona without a picture shows the person icon there and in the header; the assistant keeps its robot.
- There is no local per-persona conversation map any more: `kurisu_persona_conversations` (and its `'unbound'` key) is in `LEGACY_STORAGE_KEYS` and dropped at startup by `storage.clearLegacyAgentKeys()`.

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
- `/persona` — opens the chat header's persona sheet (`kurisu:open-persona-picker`). A switch of the persona in use, for every conversation, saved with `PATCH /assistant` (#354)
- `/resume` — opens the conversation picker over every conversation; none is tied to a persona (#354)
- `/compact` — compact conversation context (sends `compact_context` WebSocket event). The backend answers `context_info` twice, `compacting: true` then `compacting: false` carrying the summary and the new watermark, and compacts **in place**: same conversation, same id, same transcript on screen. `useStreamingChat` records the watermark and reloads the conversation. It used to fork into a new conversation announced by `conversation_switched`; that event is gone (#99)
- `/clear` — start a new empty conversation + clear the persona mapping entry
- Autocomplete dropdown in `ChatComposer`: filtered on `/` prefix, Enter auto-selects first match, closes dropdown after selection
- All `/`-prefixed input intercepted client-side, never sent to backend
- Commands return feedback strings shown as info toasts
- `handleCommand()` is async, returns `Promise<string | null>`

## Composer scope
- `ChatComposer` takes `conversationId` (nullable) rather than a string key — the conversation alone is the draft's scope; switching the persona in use keeps the conversation and so the draft (#354). It resolves asynchronously after login — the latest conversation loads — and a draft typed in that window must survive it.
- The scope effect clears `input` and `images` only when **leaving a concrete conversation**: the previous conversation had an id and it changed — with or without a persona in use. `null → id` is the scope becoming known, not a switch, so the draft stays. Before this the effect cleared on any change, which lost real keystrokes and is what left the e2e composer disabled right after `fill()` on Windows CI (#145).
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
