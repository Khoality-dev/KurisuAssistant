import { useState, useEffect, useRef, useCallback } from 'react';
import { wsManager, StreamChunkEvent, DoneEvent, ErrorEvent, ConnectedEvent, ToolApprovalRequestEvent, ContextInfoEvent } from '../api/websocket';
import { useConversationStore } from '../store/conversationStore';
import { storage } from '../utils/storage';
import { stripNarration, fileToBase64 } from '../utils/chat';
import { useExplorerStore } from '../store/explorerStore';
import { useAgentStore } from '../store/agentStore';
import { apiClient } from '../api/client';
import type { Message } from '../api/types';
import type { AmplitudeState } from '../videocall/CharacterRenderer';
import { handleCommand } from '../utils/commands';

export interface UseStreamingChatParams {
  agentId: number | null;
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
  pushAgentCharacterConfig: (agentId: number | undefined, agentName?: string) => void;
}

export interface UseStreamingChatReturn {
  isStreaming: boolean;
  streamingMessages: Message[];
  streamingContent: string;
  streamingThinking: string;
  justFinishedStreaming: boolean;
  expandedThinking: Set<number>;
  activeConversationId: number | null;
  errorToast: string | null;
  setErrorToast: (v: string | null) => void;
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
  handleDelete: (messageIndex: number) => Promise<void>;
  handleResend: (messageIndex: number) => Promise<void>;
  pendingApproval: ToolApprovalRequestEvent | null;
  respondToApproval: (approved: boolean) => void;
  contextTokens: number;
  contextLimit: number;
  isCompacting: boolean;
}

export function useStreamingChat({
  agentId,
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
  pushAgentCharacterConfig,
}: UseStreamingChatParams): UseStreamingChatReturn {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingMessages, setStreamingMessages] = useState<Message[]>([]);
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
  const [pendingApproval, setPendingApproval] = useState<ToolApprovalRequestEvent | null>(null);
  const [contextTokens, setContextTokens] = useState(0);
  const [isCompacting, setIsCompacting] = useState(false);

  // Ref to track streaming state without stale closures
  const isStreamingRef = useRef(false);

  // Refs for streaming state (to avoid stale closures in callbacks)
  const streamingStateRef = useRef({
    currentRole: null as string | null,
    currentAgentId: undefined as number | undefined,
    currentAgentName: undefined as string | undefined,
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
  const streamFrameRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const pendingStreamRef = useRef<{ content: string; thinking: string }>({ content: '', thinking: '' });
  const prevConversationIdRef = useRef<number | null>(null);

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

  // Conversation change cleanup
  useEffect(() => {
    const newId = currentConversation?.id || null;
    const isActualSwitch = prevConversationIdRef.current !== null && prevConversationIdRef.current !== newId;
    prevConversationIdRef.current = newId;

    setActiveConversationId(newId);
    // Clear local streaming state when conversation changes
    setStreamingMessages([]);
    setStreamingContent('');
    setStreamingThinking('');
    setJustFinishedStreaming(false);
    setIsStreaming(false);
    isStreamingRef.current = false;
    cancelStreamUpdate();
    // Only clear TTS queue on actual conversation switch, not on reload of the same conversation
    if (isActualSwitch) {
      clearQueue();
    }
    ttsBufferRef.current = '';
    ttsVoiceRef.current = undefined;
    streamingStateRef.current = {
      currentRole: null,
      currentAgentId: undefined,
      currentAgentName: undefined,
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

  // Scroll to bottom on new messages
  useEffect(() => {
    if (!isLoadingMessages) {
      messagesEndRef.current?.scrollIntoView({ behavior: isStreaming ? 'auto' : 'smooth' });
    }
  }, [messages, streamingMessages, streamingContent, isLoadingMessages, isStreaming]);

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

    // Ignore events for a different conversation (prevents cross-conversation leaks)
    if (event.conversation_id && state.conversationId && event.conversation_id !== state.conversationId) {
      return;
    }

    // Auto-enter streaming mode on replayed chunks (reconnect scenario)
    if (!isStreamingRef.current) {
      setIsStreaming(true);
      isStreamingRef.current = true;
    }

    // Track conversation ID
    if (event.conversation_id && !state.conversationId) {
      state.conversationId = event.conversation_id;
      setActiveConversationId(event.conversation_id);
      setCurrentConversationId(event.conversation_id);

      // Save agent-conversation mapping
      if (agentId) {
        storage.setAgentConversationId(agentId, event.conversation_id);
      } else {
        storage.setAgentConversationId('group', event.conversation_id);
      }
    }

    const messageRole = event.role;
    const agentName = event.name || undefined;
    const eventAgentId = event.agent_id ?? undefined;

    // Check if we need to create a new bubble:
    // - Role changed (user -> assistant -> tool)
    // - Agent changed (Administrator -> Agent1 -> Administrator) - compare by name since admin may not have ID
    const roleChanged = state.currentRole && messageRole !== state.currentRole;
    const agentChanged = state.hasStarted && state.currentAgentName !== agentName;
    const needsNewBubble = roleChanged || agentChanged;

    if (needsNewBubble) {
      // Flush TTS buffer from previous agent before switching
      if (storage.getTTSAutoPlay() && ttsBufferRef.current.trim()) {
        const cleaned = stripNarration(ttsBufferRef.current);
        if (cleaned) queueText(cleaned, ttsVoiceRef.current);
        ttsBufferRef.current = '';
      }      // Capture ref values before mutating. React defers updater execution,
      // so reading the ref inside the updater would see the new (wrong) value.
      const previousContent = state.accumulatedContent;
      const previousThinking = state.accumulatedThinking;

      // Finalize previous message content and add new bubble
      setStreamingMessages(prev => {
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
          name: agentName,
          agent_id: eventAgentId,
          voice_reference: event.voice_reference || undefined,
          persona_name: event.persona_name || undefined,
          model_name: event.model_name || undefined,
          provider_type: event.provider_type || undefined,
          tool_args: event.tool_args || undefined,
        });
        return updated;
      });

      state.currentRole = messageRole;
      state.currentAgentId = eventAgentId;
      state.currentAgentName = agentName;
      state.accumulatedContent = event.content || '';
      state.accumulatedThinking = '';

      // Update TTS voice for new agent
      ttsVoiceRef.current = event.voice_reference || undefined;

      // Update character panel with active agent
      pushAgentCharacterConfig(eventAgentId, agentName);

      scheduleStreamUpdate(state.accumulatedContent, state.accumulatedThinking);
    } else if (!state.hasStarted) {
      // First message chunk - update placeholder bubble
      state.hasStarted = true;
      state.currentRole = messageRole;
      state.currentAgentId = eventAgentId;
      state.currentAgentName = agentName;
      state.accumulatedContent = event.content || '';
      state.accumulatedThinking = '';

      // Update character panel with active agent
      pushAgentCharacterConfig(eventAgentId, agentName);

      if (state.hasPlaceholder) {
        // Update placeholder with actual role/agent info
        setStreamingMessages(prev => {
          const updated = [...prev];
          if (updated.length > 0) {
            updated[updated.length - 1] = {
              ...updated[updated.length - 1],
              role: messageRole,
              name: agentName,
              agent_id: eventAgentId,
              voice_reference: event.voice_reference || undefined,
              model_name: event.model_name || undefined,
              provider_type: event.provider_type || undefined,
              tool_args: event.tool_args || undefined,
            };
          }
          return updated;
        });
        state.hasPlaceholder = false;
      } else {
        setStreamingMessages(prev => [...prev, {
          role: messageRole,
          content: '',
          name: agentName,
          agent_id: eventAgentId,
          voice_reference: event.voice_reference || undefined,
          persona_name: event.persona_name || undefined,
          model_name: event.model_name || undefined,
          provider_type: event.provider_type || undefined,
          tool_args: event.tool_args || undefined,
        }]);
      }

      scheduleStreamUpdate(state.accumulatedContent, state.accumulatedThinking);
    } else {
      // Same role and agent, accumulate content
      if (event.content) {
        state.accumulatedContent += event.content;
        scheduleStreamUpdate(state.accumulatedContent, state.accumulatedThinking);
      }
    }

    // Merge images from chunk into current streaming message
    if (event.images && event.images.length > 0) {
      setStreamingMessages(prev => {
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

    // Update running token count from server
    if (event.token_count != null) {
      setContextTokens(event.token_count);
    }

    // Streaming TTS auto-play: feed complete sentences to TTS queue
    if (storage.getTTSAutoPlay() && event.content && event.role !== 'tool') {
      ttsVoiceRef.current = event.voice_reference || ttsVoiceRef.current;
      ttsBufferRef.current += event.content;
      // Split on sentence-ending punctuation; all but the last segment are complete
      const parts = ttsBufferRef.current.split(/(?<=[.!?\n])\s*/);
      if (parts.length > 1) {
        const batch = parts.slice(0, -1).join(' ');
        ttsBufferRef.current = parts[parts.length - 1];
        if (batch.trim()) {
          const cleaned = stripNarration(batch);
          if (cleaned) queueText(cleaned, ttsVoiceRef.current);
        }
      }
    }
  }, [setCurrentConversationId, scheduleStreamUpdate, queueText, pushAgentCharacterConfig]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDone = useCallback((event: DoneEvent) => {
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
    ttsVoiceRef.current = undefined;    // Do not clear activeAgentId here; TTS may still be playing after streaming ends.
    // activeAgentId is cleared when isQueueActive becomes false (see effect below).

    // Finalize last streaming message with accumulated content
    setStreamingMessages(prev => {
      if (prev.length === 0) return prev;
      const updated = [...prev];
      updated[updated.length - 1] = {
        ...updated[updated.length - 1],
        content: state.accumulatedContent,
        thinking: state.accumulatedThinking || undefined,
      };
      return updated;
    });

    // Brief delay before showing "done" indicator
    setTimeout(async () => {
      cancelStreamUpdate();
      setStreamingContent('');
      setStreamingThinking('');
      setJustFinishedStreaming(true);
      setIsStreaming(false);

      // Reload conversation to get proper message IDs, agent info, and has_raw_data flags
      if (event.conversation_id) {
        try {
          await loadConversation(event.conversation_id);
        } catch (e) {
          console.error(e);
        }
      }
      // Clear streaming messages after store is updated with DB records
      setStreamingMessages([]);
      // Refresh sidebar previews
      useAgentStore.getState().loadAgentPreviews();
    }, 300);
  }, [loadConversation, queueText]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleError = useCallback((event: ErrorEvent) => {
    console.error('WebSocket error:', event.error);
    setErrorToast(event.error);
    setStreamingMessages([]);
    cancelStreamUpdate();
    setStreamingContent('');
    setStreamingThinking('');
    setIsStreaming(false);
  }, []);

  const handleConnected = useCallback((event: ConnectedEvent) => {
    if (event.chat_active && event.conversation_id) {      // Server still has an active streaming task; enter streaming mode and load
      // already-persisted messages (user msg + any completed agent messages)
      if (!isStreamingRef.current) {
        setIsStreaming(true);
        isStreamingRef.current = true;
      }
      loadConversation(event.conversation_id).catch(console.error);
    } else if (!event.chat_active && event.conversation_id) {      // Task finished while we were disconnected; reload once from the database
      const convId = event.conversation_id;
      loadConversation(convId)
        .then(() => setStreamingMessages([]))
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

    const onApproval = (e: ToolApprovalRequestEvent) => setPendingApproval(e);
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

    wsManager.on('stream_chunk', onChunk);
    wsManager.on('done', onDone);
    wsManager.on('error', onError);
    wsManager.on('connected', onConnected);
    wsManager.on('tool_approval_request', onApproval);
    wsManager.on('context_info', onContextInfo);

    return () => {
      wsManager.off('stream_chunk', onChunk);
      wsManager.off('done', onDone);
      wsManager.off('error', onError);
      wsManager.off('connected', onConnected);
      wsManager.off('tool_approval_request', onApproval);
      wsManager.off('context_info', onContextInfo);
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
    setIsStreaming(true);

    // Prepend file selection references if any (model reads content via tools)
    const { selections, liveSelections, clearAllSelections } = useExplorerStore.getState();
    const refs: string[] = [];
    const seen = new Set<string>();
    for (const sel of selections) {
      const ref = sel.startLine > 0
        ? `[${sel.filePath}:${sel.startLine}:${sel.startColumn}-${sel.endLine}:${sel.endColumn}]`
        : `[${sel.filePath}]`;
      if (!seen.has(ref)) { refs.push(ref); seen.add(ref); }
    }
    for (const ls of liveSelections) {
      const ref = ls.isWholeFile
        ? `[${ls.filePath}]`
        : `[${ls.filePath}:${ls.startLine}:${ls.startColumn}-${ls.endLine}:${ls.endColumn}]`;
      if (!seen.has(ref)) { refs.push(ref); seen.add(ref); }
    }
    if (refs.length > 0) {
      text = refs.join(' ') + '\n' + text;
      clearAllSelections();
    }

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
      };

      // Send user text as subtitle
      window.electron?.characterWindow?.sendSubtitle({ text, isUser: true });

      // Add user message + placeholder to local streaming state (not store)
      setStreamingMessages([userMessage, { role: 'assistant', content: '' }]);

      // Reset streaming state
      streamingStateRef.current = {
        currentRole: null,
        currentAgentId: undefined,
        currentAgentName: undefined,
        accumulatedContent: '',
        accumulatedThinking: '',
        hasPlaceholder: true,
        hasStarted: false,
        conversationId: activeConversationId,
      };

      setStreamingContent('');
      setStreamingThinking('');
      setJustFinishedStreaming(false);

      // Send via WebSocket
      await wsManager.sendChatRequest(
        userMessage.content,
        '', // Model determined by backend
        activeConversationId,
        agentId, // Single agent mode or null for Administrator routing
        imageBase64
      );
    } catch (err: any) {
      console.error('Chat error:', err);
      setStreamingMessages(prev => {
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
  }, [activeConversationId, agentId, clearQueue, setCurrentConversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSend = useCallback(async (text: string, imageFiles: File[]) => {
    if (!text.trim() || isStreaming) return;
    const trimmed = text.trim();

    // Handle slash commands (e.g. /compact)
    if (trimmed.startsWith('/') && handleCommand(trimmed, { activeConversationId, agentId })) {
      return;
    }

    await _doSend(trimmed, imageFiles);
  }, [_doSend, isStreaming, activeConversationId, agentId]);

  const handleCancel = () => {
    wsManager.sendCancel();

    // Stop TTS auto-play
    clearQueue();
    ttsBufferRef.current = '';
    ttsVoiceRef.current = undefined;

    // Clear subtitle
    window.electron?.characterWindow?.sendSubtitle({ text: '', isUser: false });

    // Finalize streaming messages with partial content
    const state = streamingStateRef.current;
    setStreamingMessages(prev => {
      if (prev.length === 0) return prev;
      const updated = [...prev];
      updated[updated.length - 1] = {
        ...updated[updated.length - 1],
        content: state.accumulatedContent,
        thinking: state.accumulatedThinking || undefined,
      };
      return updated;
    });

    setIsStreaming(false);
    cancelStreamUpdate();
    setStreamingContent('');
    setStreamingThinking('');
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

  const handleDelete = useCallback(async (messageIndex: number) => {
    const combined = [...messages, ...streamingMessages];
    const message = combined[messageIndex];
    if (!message?.id || !activeConversationId) return;

    try {
      await apiClient.deleteMessage(message.id);
      await loadConversation(activeConversationId);
    } catch (e) {
      console.error('Failed to delete message:', e);
    }
  }, [messages, streamingMessages, activeConversationId, loadConversation]);

  const handleResend = useCallback(async (messageIndex: number) => {
    if (isStreaming) return;

    const combined = [...messages, ...streamingMessages];
    const message = combined[messageIndex];
    if (!message?.id || message.role !== 'user' || !activeConversationId) return;

    const text = message.content;

    try {
      // Delete from this message onward
      await apiClient.deleteMessage(message.id);
      await loadConversation(activeConversationId);

      // Re-send the same text
      setIsStreaming(true);
      clearQueue();
      ttsBufferRef.current = '';
      ttsVoiceRef.current = undefined;

      const userMessage: Message = { role: 'user', content: text, images: [] };
      setStreamingMessages([userMessage, { role: 'assistant', content: '' }]);

      streamingStateRef.current = {
        currentRole: null,
        currentAgentId: undefined,
        currentAgentName: undefined,
        accumulatedContent: '',
        accumulatedThinking: '',
        hasPlaceholder: true,
        hasStarted: false,
        conversationId: activeConversationId,
      };

      setStreamingContent('');
      setStreamingThinking('');
      setJustFinishedStreaming(false);

      await wsManager.sendChatRequest(text, '', activeConversationId, agentId, []);
    } catch (e) {
      console.error('Failed to resend message:', e);
      setIsStreaming(false);
    }
  }, [isStreaming, messages, streamingMessages, activeConversationId, loadConversation, clearQueue, agentId]);

  const respondToApproval = useCallback((approved: boolean) => {
    if (!pendingApproval) return;
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
    handleDelete,
    handleResend,
    pendingApproval,
    respondToApproval,
    contextTokens,
    contextLimit: 0,  // Frontend determines limit from model config
    isCompacting,
  };
}
