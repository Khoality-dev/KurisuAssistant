import { useState, useEffect, useRef, useCallback } from 'react';
import { wsManager, StreamChunkEvent, DoneEvent, ErrorEvent, ConnectedEvent, ToolApprovalRequestEvent, ContextInfoEvent, ConversationSwitchedEvent } from '../api/websocket';
import { useConversationStore } from '../store/conversationStore';
import { useToolPermissionsStore } from '../store/toolPermissionsStore';
import { storage } from '../utils/storage';
import { stripNarration, fileToBase64 } from '../utils/chat';
import { useExplorerStore } from '../store/explorerStore';
import { usePersonaStore } from '../store/personaStore';
import type { Message } from '../api/types';
import type { AmplitudeState } from '../videocall/CharacterRenderer';
import { handleCommand } from '../utils/commands';

/**
 * A streaming bubble, plus the two tool-call fields the wire sends but the stored
 * `Message` has no room for. `tool_kind` and `duration_ms` arrive only on tool
 * chunks and are never persisted, so they live on the streaming message alone —
 * a client cannot derive either.
 */
export type StreamingMessage = Message & {
  tool_kind?: 'tool' | 'sub_agent' | null;
  duration_ms?: number | null;
};

export interface UseStreamingChatParams {
  personaId: number | null;
  currentConversation: { id: number } | null;
  messages: Message[];
  hasMoreMessages: boolean;
  isLoadingMessages: boolean;
  loadMoreMessages: () => void;
  loadConversation: (id: number) => Promise<void>;
  setCurrentConversationId: (id: number) => void;
  // TTS
  queueText: (text: string, voice?: string) => void;
  clearQueue: () => void;
  // Character panel
  amplitudeRef: React.MutableRefObject<AmplitudeState>;
  pushPersonaCharacterConfig: (personaId: number | undefined, personaName?: string) => void;
}

export interface UseStreamingChatReturn {
  isStreaming: boolean;
  streamingMessages: StreamingMessage[];
  streamingContent: string;
  streamingThinking: string;
  justFinishedStreaming: boolean;
  expandedThinking: Set<number>;
  activeConversationId: number | null;
  errorToast: string | null;
  setErrorToast: (v: string | null) => void;
  infoToast: string | null;
  setInfoToast: (v: string | null) => void;
  externalDraft: string;
  externalDraftVersion: number;
  pushExternalDraft: (text: string) => void;
  clearExternalDraft: () => void;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  messagesContainerRef: React.RefObject<HTMLDivElement>;
  handleSend: (text: string, imageFiles: File[]) => Promise<void>;
  handleSendText: (text: string) => Promise<void>;
  handleCancel: () => void;
  toggleThinking: (index: number) => void;
  queuedMessages: Message[];
  pendingApproval: ToolApprovalRequestEvent | null;
  respondToApproval: (response: string) => void;
  contextTokens: number;
  contextLimit: number;
  isCompacting: boolean;
}

export function useStreamingChat({
  personaId,
  currentConversation,
  messages,
  hasMoreMessages,
  isLoadingMessages,
  loadMoreMessages,
  loadConversation,
  setCurrentConversationId,
  queueText,
  clearQueue,
  amplitudeRef,
  pushPersonaCharacterConfig,
}: UseStreamingChatParams): UseStreamingChatReturn {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingMessages, setStreamingMessages] = useState<StreamingMessage[]>([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingThinking, setStreamingThinking] = useState('');
  const [justFinishedStreaming, setJustFinishedStreaming] = useState(false);
  const [expandedThinking, setExpandedThinking] = useState<Set<number>>(new Set());
  const [externalDraft, setExternalDraft] = useState('');
  const [externalDraftVersion, setExternalDraftVersion] = useState(0);
  const [activeConversationId, setActiveConversationId] = useState<number | null>(
    currentConversation?.id || null
  );
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const [infoToast, setInfoToast] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<ToolApprovalRequestEvent | null>(null);
  const [contextTokens, setContextTokens] = useState(0);
  const [isCompacting, setIsCompacting] = useState(false);
  const [queuedMessages, setQueuedMessages] = useState<Message[]>([]);

  // Ref to track streaming state without stale closures
  const isStreamingRef = useRef(false);
  const cancelledRef = useRef(false);

  // Refs for streaming state (to avoid stale closures in callbacks)
  const streamingStateRef = useRef({
    currentRole: null as string | null,
    currentPersonaId: undefined as number | undefined,
    // Speaker label of the bubble being written: the persona name on assistant
    // chunks, the tool label on tool chunks.
    currentName: undefined as string | undefined,
    accumulatedContent: '',
    accumulatedThinking: '',
    hasPlaceholder: false,
    hasStarted: false,
    conversationId: null as number | null,
  });

  const ttsBufferRef = useRef('');
  const ttsVoiceRef = useRef<string | undefined>(undefined);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const previousScrollHeightRef = useRef<number>(0);
  // Tracks the container's scrollHeight from the previous render so we can decide
  // whether the user was at the bottom *before* this update. If they were, we keep
  // them pinned to the bottom; if they had scrolled up, we leave them alone.
  const lastScrollHeightRef = useRef<number>(0);
  const streamFrameRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const pendingStreamRef = useRef<{ content: string; thinking: string }>({ content: '', thinking: '' });
  const prevConversationIdRef = useRef<number | null>(null);

  // Bumped once per turn. `handleConnected` restores a finished turn by reloading
  // the conversation, which is asynchronous: if a new turn starts while that read
  // is in flight, the snapshot it returns predates the turn and would overwrite
  // it. The counter lets the restore notice that and defer instead.
  const turnSeqRef = useRef(0);
  // Set when a restore was deferred for that reason; handleDone re-reads once the
  // turn is persisted.
  const pendingRestoreRef = useRef<number | null>(null);

  // Authoritative copy of streamingMessages, kept in lockstep with React state
  // by `updateStreaming` below. Updating it on render (the previous approach)
  // was racy: a chunk's setState could be batched and unflushed when the next
  // chunk's handler — or handleDone — read this ref, returning a stale array
  // and dropping the in-progress bubble. The ref is the source of truth now;
  // setStreamingMessages is just a notifier.
  const streamingMessagesRef = useRef<StreamingMessage[]>([]);
  const updateStreaming = useCallback(
    (updater: StreamingMessage[] | ((prev: StreamingMessage[]) => StreamingMessage[])) => {
      const next = typeof updater === 'function'
        ? (updater as (prev: StreamingMessage[]) => StreamingMessage[])(streamingMessagesRef.current)
        : updater;
      streamingMessagesRef.current = next;
      setStreamingMessages(next);
    },
    [],
  );

  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  const pushExternalDraft = useCallback((text: string) => {
    setExternalDraft(text);
    setExternalDraftVersion((prev) => prev + 1);
  }, []);

  const clearExternalDraft = useCallback(() => {
    setExternalDraft('');
    setExternalDraftVersion((prev) => prev + 1);
  }, []);

  const cancelStreamUpdate = () => {
    if (streamFrameRef.current !== null) {
      cancelAnimationFrame(streamFrameRef.current);
      streamFrameRef.current = null;
    }
  };

  const scheduleStreamUpdate = useCallback((content: string, thinking: string) => {
    pendingStreamRef.current = { content, thinking };
    if (streamFrameRef.current === null) {
      streamFrameRef.current = requestAnimationFrame(() => {
        const next = pendingStreamRef.current;
        setStreamingContent(next.content);
        setStreamingThinking(next.thinking);
        streamFrameRef.current = null;
      });
    }
  }, []);

  // Conversation change cleanup.
  //
  // This effect fires whenever `currentConversation` gets a new object reference —
  // including the null→N transition that happens when a chunk assigns the
  // first-ever conversation_id during an active stream, and the background
  // reload after `done` that replaces the conversation object with the same id.
  // Wiping streaming state on those transitions would erase the user bubble and
  // reset the accumulator mid-stream, so we only clear on an *actual* switch
  // to a different conversation.
  useEffect(() => {
    const newId = currentConversation?.id || null;
    const prevId = prevConversationIdRef.current;
    const isActualSwitch = prevId !== null && newId !== null && prevId !== newId;
    prevConversationIdRef.current = newId;

    setActiveConversationId(newId);

    if (!isActualSwitch) {
      // Keep streaming/TTS state intact: this is either initial mount, a
      // null→N transition on first chunk of a new conversation, or a same-id
      // reload after done.
      return;
    }

    // Clear local streaming state on a real switch.
    updateStreaming([]);
    setStreamingContent('');
    setStreamingThinking('');
    setJustFinishedStreaming(false);
    setIsStreaming(false);
    isStreamingRef.current = false;
    cancelStreamUpdate();
    clearQueue();
    ttsBufferRef.current = '';
    ttsVoiceRef.current = undefined;
    streamingStateRef.current = {
      currentRole: null,
      currentPersonaId: undefined,
      currentName: undefined,
      accumulatedContent: '',
      accumulatedThinking: '',
      hasPlaceholder: false,
      hasStarted: false,
      conversationId: newId,
    };
  }, [currentConversation]); // eslint-disable-line react-hooks/exhaustive-deps

  // cancelStreamUpdate cleanup on unmount
  useEffect(() => {
    return () => {
      cancelStreamUpdate();
    };
  }, []);

  // Reset "just finished" indicator after 3 seconds
  useEffect(() => {
    if (justFinishedStreaming) {
      const timer = setTimeout(() => {
        setJustFinishedStreaming(false);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [justFinishedStreaming]);

  // Reset scroll tracking on conversation switch so the new conversation pins
  // to the bottom on first render (oldHeight=0 → distFromBottom is non-positive).
  useEffect(() => {
    lastScrollHeightRef.current = 0;
  }, [currentConversation?.id]);

  // Auto-scroll on streaming/message updates, but only if the user was already
  // near the bottom of the *previous* content. Always 'auto' — 'smooth' produces
  // a visible scroll animation when the stream finishes (state flips like
  // setStreamingMessages([])/setStreamingContent('') and the post-done reload
  // each retrigger the effect). Note: isStreaming intentionally not in deps —
  // toggling it shouldn't cause a scroll on its own.
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const oldHeight = lastScrollHeightRef.current;
    lastScrollHeightRef.current = container.scrollHeight;
    if (isLoadingMessages) return;
    const distFromBottom = oldHeight
      ? oldHeight - container.scrollTop - container.clientHeight
      : 0;
    if (distFromBottom < 100) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [messages, streamingMessages, streamingContent, isLoadingMessages]);

  // Preserve scroll position after loading more messages
  useEffect(() => {
    if (!isLoadingMessages && previousScrollHeightRef.current > 0) {
      const container = messagesContainerRef.current;
      if (container) {
        const newScrollHeight = container.scrollHeight;
        const scrollDiff = newScrollHeight - previousScrollHeightRef.current;
        container.scrollTop = scrollDiff;
        previousScrollHeightRef.current = 0;
      }
    }
  }, [isLoadingMessages]);

  // WebSocket event handlers
  const handleStreamChunk = useCallback((event: StreamChunkEvent) => {
    const state = streamingStateRef.current;

    // Ignore late chunks after cancel
    if (cancelledRef.current) return;

    // Ignore events for a different conversation (prevents cross-conversation leaks)
    if (event.conversation_id && state.conversationId && event.conversation_id !== state.conversationId) {
      return;
    }

    // Auto-enter streaming mode on replayed chunks (reconnect scenario)
    if (!isStreamingRef.current) {
      turnSeqRef.current++;
      setIsStreaming(true);
      isStreamingRef.current = true;
    }

    // Track conversation ID
    if (event.conversation_id && !state.conversationId) {
      state.conversationId = event.conversation_id;
      setActiveConversationId(event.conversation_id);
      setCurrentConversationId(event.conversation_id);

      // Save the persona → conversation mapping. With no persona selected the
      // conversation lands under 'unbound' until a chunk tells us who answered.
      storage.setPersonaConversationId(personaId ?? 'unbound', event.conversation_id);
    }

    const messageRole = event.role;
    // `name` is the persona name on assistant chunks and the tool label on tool
    // chunks; `persona_id`/`persona_name` are null on tool chunks.
    const chunkName = event.name || undefined;
    const eventPersonaId = event.persona_id ?? undefined;

    // A conversation started with no persona selected sits under the 'unbound'
    // key. The first assistant chunk names the persona the backend bound it to,
    // so re-key it now — that is the only moment the client can learn it.
    if (state.conversationId && eventPersonaId && !personaId
        && storage.getPersonaConversationId('unbound') === state.conversationId) {
      storage.setPersonaConversationId(eventPersonaId, state.conversationId);
      storage.clearPersonaConversationId('unbound');
    }

    // Start a new bubble when the role changes (user → assistant → tool) or the
    // speaker changes. The speaker is the persona on assistant chunks — compare
    // persona_id, which is authoritative and survives two personas sharing a
    // name. Tool chunks carry no persona at all, so there the speaker is the
    // tool label in `name`: a different tool gets its own bubble.
    const roleChanged = state.currentRole && messageRole !== state.currentRole;
    const speakerChanged = state.hasStarted && (
      messageRole === 'tool'
        ? state.currentName !== chunkName
        : state.currentPersonaId !== eventPersonaId
    );
    const needsNewBubble = roleChanged || speakerChanged;

    if (needsNewBubble) {
      // Flush TTS buffer from the previous speaker before switching
      if (storage.getTTSAutoPlay() && ttsBufferRef.current.trim()) {
        const cleaned = stripNarration(ttsBufferRef.current);
        if (cleaned) queueText(cleaned, ttsVoiceRef.current);
        ttsBufferRef.current = '';
      }      // Capture ref values before mutating. React defers updater execution,
      // so reading the ref inside the updater would see the new (wrong) value.
      const previousContent = state.accumulatedContent;
      const previousThinking = state.accumulatedThinking;

      // Finalize previous message content and add new bubble
      updateStreaming(prev => {
        const updated = [...prev];
        if (updated.length > 0) {
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            content: previousContent,
            thinking: previousThinking || undefined,
          };
        }
        updated.push({
          role: messageRole,
          content: '',
          name: chunkName,
          persona_id: eventPersonaId,
          voice_reference: event.voice_reference || undefined,
          persona_name: event.persona_name || undefined,
          model_name: event.model_name || undefined,
          provider_type: event.provider_type || undefined,
          tool_args: event.tool_args || undefined,
          tool_status: event.tool_status || undefined,
          tool_kind: event.tool_kind ?? undefined,
          duration_ms: event.duration_ms ?? undefined,
          _clientKey: crypto.randomUUID(),
        });
        return updated;
      });

      state.currentRole = messageRole;
      state.currentPersonaId = eventPersonaId;
      state.currentName = chunkName;
      state.accumulatedContent = event.content || '';
      state.accumulatedThinking = '';

      // Update TTS voice for the new speaker
      ttsVoiceRef.current = event.voice_reference || undefined;

      // Point the character panel at the persona now speaking (no-op on tool
      // chunks, which carry no persona id)
      pushPersonaCharacterConfig(eventPersonaId, chunkName);

      scheduleStreamUpdate(state.accumulatedContent, state.accumulatedThinking);
    } else if (!state.hasStarted) {
      // First message chunk - update placeholder bubble
      state.hasStarted = true;
      state.currentRole = messageRole;
      state.currentPersonaId = eventPersonaId;
      state.currentName = chunkName;
      state.accumulatedContent = event.content || '';
      state.accumulatedThinking = '';

      // Point the character panel at the persona now speaking
      pushPersonaCharacterConfig(eventPersonaId, chunkName);

      if (state.hasPlaceholder) {
        // Update placeholder with the real role/speaker info
        updateStreaming(prev => {
          const updated = [...prev];
          if (updated.length > 0) {
            updated[updated.length - 1] = {
              ...updated[updated.length - 1],
              role: messageRole,
              name: chunkName,
              persona_id: eventPersonaId,
              persona_name: event.persona_name || undefined,
              voice_reference: event.voice_reference || undefined,
              model_name: event.model_name || undefined,
              provider_type: event.provider_type || undefined,
              tool_args: event.tool_args || undefined,
              tool_status: event.tool_status || undefined,
              tool_kind: event.tool_kind ?? undefined,
              duration_ms: event.duration_ms ?? undefined,
            };
          }
          return updated;
        });
        state.hasPlaceholder = false;
      } else {
        updateStreaming(prev => [...prev, {
          role: messageRole,
          content: '',
          name: chunkName,
          persona_id: eventPersonaId,
          voice_reference: event.voice_reference || undefined,
          persona_name: event.persona_name || undefined,
          model_name: event.model_name || undefined,
          provider_type: event.provider_type || undefined,
          tool_args: event.tool_args || undefined,
          tool_status: event.tool_status || undefined,
          tool_kind: event.tool_kind ?? undefined,
          duration_ms: event.duration_ms ?? undefined,
          _clientKey: crypto.randomUUID(),
        }]);
      }

      scheduleStreamUpdate(state.accumulatedContent, state.accumulatedThinking);
    } else {
      // Same role and same speaker — accumulate content
      if (event.content) {
        state.accumulatedContent += event.content;
        scheduleStreamUpdate(state.accumulatedContent, state.accumulatedThinking);
      }
    }

    // Merge images from chunk into current streaming message
    if (event.images && event.images.length > 0) {
      updateStreaming(prev => {
        const updated = [...prev];
        if (updated.length > 0) {
          const last = updated[updated.length - 1];
          updated[updated.length - 1] = {
            ...last,
            images: [...(last.images || []), ...event.images!],
          };
        }
        return updated;
      });
    }

    // Always accumulate thinking + update isThinking for character transitions
    if (event.thinking) {
      state.accumulatedThinking += event.thinking;
      amplitudeRef.current = { ...amplitudeRef.current, isThinking: true };
      scheduleStreamUpdate(state.accumulatedContent, state.accumulatedThinking);
    }
    if (event.content) {      // Content arrived, so the thinking phase is over
      amplitudeRef.current = { ...amplitudeRef.current, isThinking: false };
    }

    // Update running token count from server and persist to store
    if (event.token_count != null) {
      setContextTokens(event.token_count);
    }

    // Streaming TTS auto-play: feed complete sentences to TTS queue
    // Only queue when we have full sentences AND enough words (min 10)
    if (storage.getTTSAutoPlay() && event.content && event.role !== 'tool') {
      ttsVoiceRef.current = event.voice_reference || ttsVoiceRef.current;
      ttsBufferRef.current += event.content;
      // Split on sentence-ending punctuation; all but the last segment are complete
      const parts = ttsBufferRef.current.split(/(?<=[.!?。！？\n])\s*/);
      if (parts.length > 1) {
        const completeSentences = parts.slice(0, -1).join(' ');
        const wordCount = completeSentences.trim().split(/\s+/).length;
        if (wordCount >= 10) {
          ttsBufferRef.current = parts[parts.length - 1];
          const cleaned = stripNarration(completeSentences);
          if (cleaned) queueText(cleaned, ttsVoiceRef.current);
        }
        // If < 10 words, keep accumulating — don't update buffer
      }
    }
  }, [setCurrentConversationId, scheduleStreamUpdate, queueText, pushPersonaCharacterConfig]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDone = useCallback((event: DoneEvent) => {
    cancelledRef.current = false;
    const state = streamingStateRef.current;

    // Ignore done events for a different conversation
    if (event.conversation_id && state.conversationId && event.conversation_id !== state.conversationId) {
      return;
    }

    // Clear thinking state
    amplitudeRef.current = { ...amplitudeRef.current, isThinking: false };

    // Flush remaining TTS buffer
    if (storage.getTTSAutoPlay() && ttsBufferRef.current.trim()) {
      const cleaned = stripNarration(ttsBufferRef.current);
      if (cleaned) queueText(cleaned, ttsVoiceRef.current);
    }
    ttsBufferRef.current = '';
    ttsVoiceRef.current = undefined;    // Do not clear activePersonaId here; TTS may still be playing after streaming ends.
    // activePersonaId is cleared when isQueueActive becomes false (see effect below).

    // Build the finalized array directly from the ref + accumulator instead of
    // routing it through setStreamingMessages → flushSync → ref. The previous
    // approach was racy: when a stream chunk arrived microseconds before the
    // done event (common at the end of a multi-role stream), the ref still
    // pointed to a render-stale array (3 bubbles instead of 4) and the last
    // bubble was lost from the store. Computing finalized inline removes the
    // dependency on render timing entirely.
    const current = streamingMessagesRef.current;
    const finalized: Message[] = current.length > 0
      ? [
          ...current.slice(0, -1),
          {
            ...current[current.length - 1],
            content: state.accumulatedContent,
            thinking: state.accumulatedThinking || undefined,
          },
        ]
      : [];

    cancelStreamUpdate();
    setStreamingContent('');
    setStreamingThinking('');
    setJustFinishedStreaming(true);
    setIsStreaming(false);

    // Streaming → store handoff. Order matters: clear local streaming state
    // FIRST, then append to the store. The reverse order leaves a window
    // (between Zustand commit and React commit) where the same bubble lives
    // in both arrays and renders twice — a strict-mode locator violation in
    // tests. Clearing first means a one-frame "no bubble" flicker, but React
    // 18 batches both updates so in practice the user sees one re-render.
    updateStreaming([]);
    if (finalized.length > 0) {
      useConversationStore.getState().appendMessages(finalized);
    }
    // Drop any queued messages — backend will stream them next.
    setQueuedMessages([]);

    // Refresh persona previews (last-message snippet on the sidebar). No
    // conversation reload: streaming chunks already deliver every field the
    // bubble needs, and resend/delete/raw-data have been removed, so the
    // missing DB ids are no longer load-bearing on the client.
    if (event.conversation_id) {
      usePersonaStore.getState().loadPersonaPreviews();
    }

    // A `connected` restore landed mid-turn and deferred rather than overwrite
    // it. The snapshot it applied is stale by exactly this turn, so re-read now
    // that the turn is persisted.
    const pendingRestore = pendingRestoreRef.current;
    if (pendingRestore !== null) {
      pendingRestoreRef.current = null;
      loadConversation(pendingRestore).catch(console.error);
    }
  }, [queueText]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleError = useCallback((event: ErrorEvent) => {
    console.error('WebSocket error:', event.error);
    setErrorToast(event.error);
    updateStreaming([]);
    cancelStreamUpdate();
    setStreamingContent('');
    setStreamingThinking('');
    setIsStreaming(false);
  }, [updateStreaming]);

  const handleConnected = useCallback((event: ConnectedEvent) => {
    if (event.chat_active && event.conversation_id) {      // Server still has an active streaming task; enter streaming mode and load
      // already-persisted messages (user msg + any completed assistant messages)
      if (!isStreamingRef.current) {
        setIsStreaming(true);
        isStreamingRef.current = true;
      }
      loadConversation(event.conversation_id).catch(console.error);
    } else if (!event.chat_active && event.conversation_id) {      // Task finished while we were disconnected; reload once from the database.
      // The read is asynchronous and the user may send again before it lands —
      // on a reconnect the queued message flushes the moment the socket opens,
      // which is the same tick this event arrives.
      //
      // Clearing the streaming buffer then is actively destructive, not merely
      // stale: `updateStreaming([])` empties the array but leaves
      // `streamingStateRef` claiming a placeholder bubble still exists, so every
      // later chunk of that turn is written into a bubble that is no longer
      // there and the whole reply is lost. Skip the clear while a turn is live
      // (and if one merely began and ended during the read), and let handleDone
      // re-read once it is persisted.
      const convId = event.conversation_id;
      const seq = turnSeqRef.current;
      loadConversation(convId)
        .then(() => {
          if (isStreamingRef.current || turnSeqRef.current !== seq) {
            pendingRestoreRef.current = convId;
            return;
          }
          updateStreaming([]);
        })
        .catch(console.error);
    }
    // If no conversation_id, nothing to restore
  }, [loadConversation]);  // Stable refs for WebSocket handlers avoid re-registering on every render.  // This prevents queueText -> playQueue -> amplitudeController churn.
  const handleStreamChunkRef = useRef(handleStreamChunk);
  handleStreamChunkRef.current = handleStreamChunk;
  const handleDoneRef = useRef(handleDone);
  handleDoneRef.current = handleDone;
  const handleErrorRef = useRef(handleError);
  handleErrorRef.current = handleError;
  const handleConnectedRef = useRef(handleConnected);
  handleConnectedRef.current = handleConnected;

  // Set up WebSocket event listeners (registered once, delegates to latest ref)
  useEffect(() => {
    const onChunk = (e: StreamChunkEvent) => handleStreamChunkRef.current(e);
    const onDone = (e: DoneEvent) => handleDoneRef.current(e);
    const onError = (e: ErrorEvent) => handleErrorRef.current(e);
    const onConnected = (e: ConnectedEvent) => handleConnectedRef.current(e);

    const onApproval = (e: ToolApprovalRequestEvent) => {
      // Check tool permissions policy before showing dialog
      const decision = useToolPermissionsStore.getState().getToolDecision(e.tool_name);
      if (decision === 'allow') {
        // Auto-approve based on policy
        wsManager.sendToolApprovalResponse(e.approval_id, true);
        return;
      }
      if (decision === 'deny') {
        // Auto-deny based on policy
        wsManager.sendToolApprovalResponse(e.approval_id, false);
        return;
      }
      // No policy - show dialog
      setPendingApproval(e);
    };
    const onContextInfo = (e: ContextInfoEvent) => {
      setIsCompacting(e.compacting);
      if (!e.compacting) {
        if (e.compacted_up_to_id) {
          useConversationStore.getState().updateCompactionData(
            e.compacted_up_to_id,
            e.compacted_context ?? '',
          );
        }
        // Reload conversation to refresh compaction data from API
        const convId = useConversationStore.getState().currentConversation?.id;
        if (convId) {
          useConversationStore.getState().loadConversation(convId);
        }
      }
    };
    const onConversationSwitched = (e: ConversationSwitchedEvent) => {
      // Compaction (manual or auto) created a new conversation seeded with the
      // rolling summary. Update the persona → conversation mapping and load the
      // new one. The summary will be visible at the top. This handler is the only
      // thing keeping the mapping correct after a compaction.
      if (e.persona_id) {
        storage.setPersonaConversationId(e.persona_id, e.new_conversation_id);
      }
      void useConversationStore.getState().loadConversation(e.new_conversation_id);
      setInfoToast('Compacted — opened a new conversation with the summary on top.');
    };

    wsManager.on('stream_chunk', onChunk);
    wsManager.on('done', onDone);
    wsManager.on('error', onError);
    wsManager.on('connected', onConnected);
    wsManager.on('tool_approval_request', onApproval);
    wsManager.on('context_info', onContextInfo);
    wsManager.on('conversation_switched', onConversationSwitched);

    return () => {
      wsManager.off('stream_chunk', onChunk);
      wsManager.off('done', onDone);
      wsManager.off('error', onError);
      wsManager.off('connected', onConnected);
      wsManager.off('tool_approval_request', onApproval);
      wsManager.off('context_info', onContextInfo);
      wsManager.off('conversation_switched', onConversationSwitched);
    };
  }, []);

  // Handle scroll to load more messages
  const handleScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container || isLoadingMessages || !hasMoreMessages) return;

    if (container.scrollTop < 100) {
      previousScrollHeightRef.current = container.scrollHeight;
      loadMoreMessages();
    }
  }, [isLoadingMessages, hasMoreMessages, loadMoreMessages]);

  const handleScrollRef = useRef(handleScroll);
  handleScrollRef.current = handleScroll;

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const onScroll = () => {
      if (scrollFrameRef.current !== null) return;
      scrollFrameRef.current = requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        handleScrollRef.current();
      });
    };

    container.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      container.removeEventListener('scroll', onScroll);
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      } else if (!storage.getTTSAutoPlay()) {
        ttsBufferRef.current = '';
      } else if (!storage.getTTSAutoPlay()) {
        ttsBufferRef.current = '';
      }
    };
  }, []);

  const handleSendText = async (overrideText: string) => {
    if (!overrideText.trim() || isStreamingRef.current) return;
    await _doSend(overrideText.trim(), []);
  };

  const _doSend = useCallback(async (text: string, imageFiles: File[]) => {
    cancelledRef.current = false;
    turnSeqRef.current++;
    setIsStreaming(true);

    // Collect file selections as structured context_files
    const { selections, liveSelections, clearAllSelections } = useExplorerStore.getState();
    const contextFiles: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (const sel of selections) {
      const key = sel.startLine > 0 ? `${sel.filePath}:${sel.startLine}-${sel.endLine}` : sel.filePath;
      if (!seen.has(key)) {
        seen.add(key);
        contextFiles.push({
          path: sel.filePath, fileName: sel.fileName,
          ...(sel.startLine > 0 ? { startLine: sel.startLine, endLine: sel.endLine, startColumn: sel.startColumn, endColumn: sel.endColumn } : {}),
        });
      }
    }
    for (const ls of liveSelections) {
      const key = ls.isWholeFile ? ls.filePath : `${ls.filePath}:${ls.startLine}-${ls.endLine}`;
      if (!seen.has(key)) {
        seen.add(key);
        contextFiles.push({
          path: ls.filePath, fileName: ls.fileName,
          ...(!ls.isWholeFile ? { startLine: ls.startLine, endLine: ls.endLine, startColumn: ls.startColumn, endColumn: ls.endColumn } : {}),
        });
      }
    }
    if (contextFiles.length > 0) clearAllSelections();

    // Clear any previous TTS queue
    clearQueue();
    ttsBufferRef.current = '';
    ttsVoiceRef.current = undefined;

    try {
      const imageBase64: string[] = [];
      for (const imageFile of imageFiles) {
        const base64 = await fileToBase64(imageFile);
        imageBase64.push(base64);
      }

      const userMessage: Message = {
        role: 'user',
        content: text,
        images: [],
        context_files: contextFiles.length > 0 ? contextFiles as Message['context_files'] : undefined,
        _clientKey: crypto.randomUUID(),
      };

      // Send user text as subtitle
      window.electron?.characterWindow?.sendSubtitle({ text, isUser: true });

      // Add user message + placeholder to local streaming state (not store)
      updateStreaming([userMessage, { role: 'assistant', content: '', _clientKey: crypto.randomUUID() }]);

      // Reset streaming state
      streamingStateRef.current = {
        currentRole: null,
        currentPersonaId: undefined,
        currentName: undefined,
        accumulatedContent: '',
        accumulatedThinking: '',
        hasPlaceholder: true,
        hasStarted: false,
        conversationId: activeConversationId,
      };

      setStreamingContent('');
      setStreamingThinking('');
      setJustFinishedStreaming(false);

      // Send via WebSocket. The persona override is sent only when starting a
      // new conversation: it tells the backend to bind the conversation it is
      // about to create to the persona the user has selected instead of the
      // assistant's default. An existing conversation already carries its
      // binding server-side, so nothing is overridden per turn.
      await wsManager.sendChatRequest(
        text,
        '', // Model determined by backend
        activeConversationId,
        imageBase64,
        contextFiles,
        activeConversationId === null ? personaId : null,
      );
    } catch (err: any) {
      console.error('Chat error:', err);
      updateStreaming(prev => {
        if (prev.length === 0) return prev;
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          content: 'Error: ' + (err.message || 'Failed to send message'),
        };
        return updated;
      });
      cancelStreamUpdate();
      setStreamingContent('');
      setStreamingThinking('');
      setIsStreaming(false);
    }
  }, [activeConversationId, personaId, clearQueue, setCurrentConversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSend = useCallback(async (text: string, imageFiles: File[]) => {
    if (!text.trim()) return;
    const trimmed = text.trim();

    // Slash commands are always client-side — never send to backend
    if (trimmed.startsWith('/')) {
      const feedback = await handleCommand(trimmed, { activeConversationId, personaId });
      if (feedback) setInfoToast(feedback);
      return;
    }

    if (isStreamingRef.current) {
      // Already streaming — queue: show dimmed user bubble below streaming content
      setQueuedMessages(prev => [...prev, { role: 'user', content: trimmed, images: [], queued: true, _clientKey: crypto.randomUUID() }]);

      const imageBase64: string[] = [];
      for (const imageFile of imageFiles) {
        const base64 = await fileToBase64(imageFile);
        imageBase64.push(base64);
      }

      await wsManager.sendChatRequest(
        trimmed,
        '',
        activeConversationId,
        imageBase64,
      );
      return;
    }

    await _doSend(trimmed, imageFiles);
  }, [_doSend, activeConversationId, personaId]);

  const handleCancel = () => {
    cancelledRef.current = true;
    wsManager.sendCancel();

    // Stop TTS auto-play
    clearQueue();
    ttsBufferRef.current = '';
    ttsVoiceRef.current = undefined;

    // Clear subtitle
    window.electron?.characterWindow?.sendSubtitle({ text: '', isUser: false });

    // Finalize streaming messages and merge into store. Read from the ref so
    // the side effect runs exactly once (StrictMode re-invokes state updaters).
    const state = streamingStateRef.current;
    const current = streamingMessagesRef.current;
    if (current.length > 0) {
      const updated = [...current];
      updated[updated.length - 1] = {
        ...updated[updated.length - 1],
        content: state.accumulatedContent,
        thinking: state.accumulatedThinking || undefined,
      };
      useConversationStore.getState().appendMessages(updated);
    }
    updateStreaming([]);

    setIsStreaming(false);
    cancelStreamUpdate();
    setStreamingContent('');
    setStreamingThinking('');
    setQueuedMessages([]);
  };

  const toggleThinking = useCallback((index: number) => {
    setExpandedThinking(prev => {
      const newSet = new Set(prev);
      if (newSet.has(index)) {
        newSet.delete(index);
      } else {
        newSet.add(index);
      }
      return newSet;
    });
  }, []);

  /**
   * Respond to a tool approval request.
   * @param response - 'approve' | 'deny' | 'always_allow' | 'always_deny' | 'session_allow'
   */
  const respondToApproval = useCallback((response: string) => {
    if (!pendingApproval) return;

    const toolName = pendingApproval.tool_name;
    const approved = response !== 'deny' && response !== 'always_deny';

    // Handle remember options
    if (response === 'always_allow') {
      useToolPermissionsStore.getState().setToolPolicy(toolName, 'allow');
    } else if (response === 'always_deny') {
      useToolPermissionsStore.getState().setToolPolicy(toolName, 'deny');
    } else if (response === 'session_allow') {
      useToolPermissionsStore.getState().addSessionApproval(toolName);
    }

    wsManager.sendToolApprovalResponse(pendingApproval.approval_id, approved);
    setPendingApproval(null);
  }, [pendingApproval]);

  return {
    isStreaming,
    streamingMessages,
    streamingContent,
    streamingThinking,
    justFinishedStreaming,
    expandedThinking,
    activeConversationId,
    errorToast,
    setErrorToast,
    infoToast,
    setInfoToast,
    externalDraft,
    externalDraftVersion,
    pushExternalDraft,
    clearExternalDraft,
    messagesEndRef,
    messagesContainerRef,
    handleSend,
    handleSendText,
    handleCancel,
    toggleThinking,
    queuedMessages,
    pendingApproval,
    respondToApproval,
    contextTokens,
    contextLimit: 0,  // Frontend determines limit from model config
    isCompacting,
  };
}
