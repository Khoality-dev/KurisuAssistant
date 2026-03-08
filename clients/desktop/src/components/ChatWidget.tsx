import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Box,
  TextField,
  Button,
  IconButton,
  Paper,
  Typography,
  Chip,
  Tooltip,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
} from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import {
  Send as SendIcon,
  AttachFile as AttachFileIcon,
  Close as CloseIcon,
  Visibility as VisibilityIcon,
  VisibilityOff as VisibilityOffIcon,
  Stop as StopIcon,
  Mic as MicIcon,
  MicOff as MicOffIcon,
  Videocam as VideocamIcon,
  VideocamOff as VideocamOffIcon,
} from '@mui/icons-material';
import CircularProgress from '@mui/material/CircularProgress';
import { AnimatePresence } from 'framer-motion';
import { useConversationStore } from '../store/conversationStore';
import { useAgentStore } from '../store/agentStore';
import { apiClient } from '../api/client';
import { wsManager, StreamChunkEvent, DoneEvent, ErrorEvent, ConnectedEvent } from '../api/websocket';
import { storage } from '../utils/storage';
import { useTTS } from '../hooks/useTTS';
import { useMicStore } from '../store/micStore';
import { useVisionStore } from '../store/visionStore';
import type { AmplitudeState } from '../videocall/CharacterRenderer';
import type { PoseTree } from '../videocall/types';
import { InteractiveCallBar } from './InteractiveCallBar';
import { MessageBubble } from './MessageBubble';
import { FrameSeparator } from './FrameSeparator';
import type { Message } from '../api/types';

interface ChatWidgetProps {
  characterWindowOpen?: boolean;
  agentId?: number | null;
}

export const ChatWidget: React.FC<ChatWidgetProps> = ({ characterWindowOpen = false, agentId = null }) => {
  const {
    messages,
    frames,
    currentConversation,
    hasMoreMessages,
    isLoadingMessages,
    loadMoreMessages,
    loadConversation,
    setCurrentConversationId,
  } = useConversationStore();

  const [input, setInput] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingMessages, setStreamingMessages] = useState<Message[]>([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingThinking, setStreamingThinking] = useState('');
  const [justFinishedStreaming, setJustFinishedStreaming] = useState(false);
  const [expandedThinking, setExpandedThinking] = useState<Set<number>>(new Set());
  const [activeConversationId, setActiveConversationId] = useState<number | null>(
    currentConversation?.id || null
  );
  // TTS settings are read fresh from storage in MessageBubble.handleTTS()
  const [showAdministrator, setShowAdministrator] = useState<boolean>(storage.getShowAdministrator());

  // Amplitude state (updated via ref to avoid re-renders, sent to character window via IPC)
  const amplitudeRef = useRef<AmplitudeState>({ amplitude: 0, isPlaying: false, isThinking: false });
  const onAmplitudeUpdate = useCallback((amplitude: number, isPlaying: boolean) => {
    amplitudeRef.current = { ...amplitudeRef.current, amplitude, isPlaying };
  }, []);

  // Character panel state — all agents in conversation
  interface AgentEntry { name: string; poseTree: PoseTree | null }
  const [agentMap, setAgentMap] = useState<Map<number, AgentEntry>>(new Map());
  const [activeAgentId, setActiveAgentId] = useState<number | null>(null);
  const agentCacheRef = useRef<Set<number>>(new Set()); // IDs already fetched

  // Subtitle: send TTS segment text + duration to character window for word-by-word reveal
  const onTTSPlaybackStart = useCallback((text: string, duration: number) => {
    window.electron?.characterWindow?.sendSubtitle({ text, isUser: false, duration });
  }, []);

  // Streaming TTS auto-play (with amplitude callback for character lip sync)
  const { speak, stop: stopTTS, isPlaying: isTTSPlaying, queueText, clearQueue, isQueueActive } = useTTS(onAmplitudeUpdate, onTTSPlaybackStart);
  // Expose TTS functions via ref so MessageBubble can use the amplitude-aware instance
  // without causing re-renders on every isTTSPlaying change
  const setActiveAgentForTTS = useCallback((agentId: number | null) => {
    setActiveAgentId(agentId);
  }, []);
  const ttsRef = useRef({ speak, stopTTS, isTTSPlaying, setActiveAgentForTTS });
  ttsRef.current = { speak, stopTTS, isTTSPlaying, setActiveAgentForTTS };
  const ttsBufferRef = useRef('');
  const ttsVoiceRef = useRef<string | undefined>(undefined);

  // Mic (ASR + interactive mode)
  const {
    status: asrStatus, result: asrResult,
    devices: asrDevices, loadDevices: loadAsrDevices, selectedDeviceId: asrDeviceId, selectDevice: selectAsrDevice,
    startListening, stopListening,
    interactiveMode, enableInteractiveMode, disableInteractiveMode,
    interactionActive, activateInteraction, deactivateInteraction,
  } = useMicStore();
  const [micMenuAnchor, setMicMenuAnchor] = useState<HTMLElement | null>(null);
  const storeAgents = useAgentStore(state => state.agents);
  const interactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingAutoSendRef = useRef<string | null>(null);
  const ttsPlayedForResponseRef = useRef(false);
  const INTERACTION_IDLE_MS = 30_000;
  const [lastTranscript, setLastTranscript] = useState('');
  const lastTranscriptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Vision (camera toggle)
  const {
    isActive: cameraActive,
    webcams: cameraWebcams,
    selectedWebcam: cameraSelectedWebcam,
    loadWebcams: loadCameraWebcams,
    startVision,
    stopVision,
    setSelectedWebcam: setCameraSelectedWebcam,
  } = useVisionStore();
  const [cameraMenuAnchor, setCameraMenuAnchor] = useState<HTMLElement | null>(null);

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

  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // Fetch agent and add/update the character panel map
  // forceRefresh=true bypasses cache (used when agent becomes active, to pick up config changes)
  const fetchAgentForPanel = useCallback((agentId: number, agentName?: string, forceRefresh = false) => {
    if (!forceRefresh && agentCacheRef.current.has(agentId)) return;
    agentCacheRef.current.add(agentId);
    apiClient.getAgent(agentId).then((agent) => {
      const cc = agent.character_config;
      const poseTree = cc?.pose_tree ?? null;
      // Migrate legacy video_url → video_urls on edges
      if (poseTree?.edges) {
        for (const e of poseTree.edges) {
          const raw = e as any;
          if (raw.video_url && !raw.video_urls?.length) {
            e.video_urls = [raw.video_url];
            delete raw.video_url;
          }
        }
      }
      setAgentMap((prev) => {
        const next = new Map(prev);
        next.set(agentId, { name: agent.name, poseTree });
        return next;
      });
    }).catch(() => {
      // Still add to map with null config so we show the name
      setAgentMap((prev) => {
        const next = new Map(prev);
        next.set(agentId, { name: agentName || `Agent ${agentId}`, poseTree: null });
        return next;
      });
    });
  }, []);

  // Set active agent during streaming (for lip sync); skip Administrator
  const pushAgentCharacterConfig = useCallback((agentId: number | undefined, agentName?: string) => {
    if (!agentId || agentName === 'Administrator') return;
    setActiveAgentId(agentId);
    fetchAgentForPanel(agentId, agentName, true);
  }, [fetchAgentForPanel]);

  // Clear active speaker when TTS queue finishes playing
  useEffect(() => {
    if (!isQueueActive && !isStreaming) {
      setActiveAgentId(null);
      amplitudeRef.current = { amplitude: 0, isPlaying: false, isThinking: false };
    }
  }, [isQueueActive, isStreaming]);

  // Reset agent map when conversation changes
  useEffect(() => {
    setAgentMap(new Map());
    agentCacheRef.current.clear();
    setActiveAgentId(null);
  }, [currentConversation?.id]);

  // Scan messages for agents to populate the character panel (skip Administrator)
  useEffect(() => {
    if (!characterWindowOpen) return;
    for (const msg of messages) {
      const name = msg.agent?.name || msg.name;
      if (msg.agent_id && name !== 'Administrator' && !agentCacheRef.current.has(msg.agent_id)) {
        fetchAgentForPanel(msg.agent_id, name);
      }
    }
  }, [messages, characterWindowOpen, fetchAgentForPanel]);

  // IPC bridge: send amplitude to character window at ~30fps
  useEffect(() => {
    if (!characterWindowOpen) return;
    const api = window.electron?.characterWindow;
    if (!api) return;
    const interval = setInterval(() => {
      api.sendAmplitude(amplitudeRef.current);
    }, 33);
    return () => clearInterval(interval);
  }, [characterWindowOpen]);

  // IPC bridge: send agent map + active agent to character window
  const agentStateRef = useRef({ agentMap, activeAgentId });
  agentStateRef.current = { agentMap, activeAgentId };

  const sendAgentState = useCallback(() => {
    const api = window.electron?.characterWindow;
    if (!api) return;
    const { agentMap: map, activeAgentId: id } = agentStateRef.current;
    const agents = Array.from(map.entries()).map(([agentId, entry]) => ({
      id: agentId,
      name: entry.name,
      poseTree: entry.poseTree,
    }));
    api.sendAgentsUpdate({ agents, activeAgentId: id });
  }, []);

  useEffect(() => {
    if (!characterWindowOpen) return;
    sendAgentState();
  }, [characterWindowOpen, agentMap, activeAgentId, sendAgentState]);

  // Re-send state when character window signals it's ready (after loading)
  useEffect(() => {
    if (!characterWindowOpen) return;
    const api = window.electron?.characterWindow;
    if (!api) return;
    const cleanup = api.onCharacterReady(() => {
      sendAgentState();
    });
    return cleanup;
  }, [characterWindowOpen, sendAgentState]);

  // Re-fetch character configs when saved in the editor dialog
  useEffect(() => {
    const handler = (e: Event) => {
      const agentId = (e as CustomEvent).detail?.agentId as number | undefined;
      if (agentId && agentMap.has(agentId)) {
        fetchAgentForPanel(agentId, undefined, true);
      }
    };
    window.addEventListener('character-config-saved', handler);
    return () => window.removeEventListener('character-config-saved', handler);
  }, [agentMap, fetchAgentForPanel]);

  // ASR transcript handling — branches on interactive mode + interaction active
  useEffect(() => {
    if (!asrResult) return;
    const asrTranscript = asrResult.text;
    const state = useMicStore.getState();

    const selectedAgent = storeAgents.find(a => a.id === agentId);
    const triggerWord = selectedAgent?.trigger_word?.trim();
    const hasTrigger = triggerWord && asrTranscript.toLowerCase().includes(triggerWord.toLowerCase());

    if (state.interactiveMode) {
      // Interactive mode — always show transcript visually
      setLastTranscript(asrTranscript);
      if (lastTranscriptTimerRef.current) clearTimeout(lastTranscriptTimerRef.current);
      lastTranscriptTimerRef.current = setTimeout(() => setLastTranscript(''), 3000);

      if (state.interactionActive || hasTrigger) {
        // Interaction active (or trigger word detected) → auto-send
        if (!state.interactionActive) activateInteraction();

        if (isStreamingRef.current) {
          pendingAutoSendRef.current = asrTranscript;
        } else {
          if (interactionTimerRef.current) {
            clearTimeout(interactionTimerRef.current);
            interactionTimerRef.current = null;
          }
          ttsPlayedForResponseRef.current = false;
          handleSendText(asrTranscript);
        }
      }
      // If not active and no trigger word → transcript shown but not sent
    } else {
      // Typing mode: put text in input field (dictation)
      setInput(asrTranscript);

      // Check trigger word → enable interactive mode + activate interaction + auto-send
      if (hasTrigger) {
        enableInteractiveMode();
        activateInteraction();
        ttsPlayedForResponseRef.current = false;
        handleSendText(asrTranscript).finally(() => setInput(''));
      }
    }
  }, [asrResult]); // eslint-disable-line react-hooks/exhaustive-deps

  // Disable interactive mode when agent or conversation changes
  useEffect(() => {
    if (useMicStore.getState().interactiveMode) {
      disableInteractiveMode();
      if (interactionTimerRef.current) {
        clearTimeout(interactionTimerRef.current);
        interactionTimerRef.current = null;
      }
      pendingAutoSendRef.current = null;
    }
  }, [agentId, currentConversation?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Start 30s idle timer when TTS finishes and streaming is done — deactivates interaction (stays in interactive mode)
  useEffect(() => {
    if (!interactiveMode || !interactionActive) return;
    // Timer starts when: not streaming AND TTS queue not active
    if (!isStreaming && !isQueueActive) {
      if (interactionTimerRef.current) {
        clearTimeout(interactionTimerRef.current);
      }
      interactionTimerRef.current = setTimeout(() => {
        deactivateInteraction();
        interactionTimerRef.current = null;
        pendingAutoSendRef.current = null;
      }, INTERACTION_IDLE_MS);
    } else {
      // Still streaming or playing TTS — clear timer
      if (interactionTimerRef.current) {
        clearTimeout(interactionTimerRef.current);
        interactionTimerRef.current = null;
      }
    }
  }, [interactiveMode, interactionActive, isStreaming, isQueueActive, deactivateInteraction]);

  // Handle pending auto-send when streaming finishes
  useEffect(() => {
    if (!isStreaming && pendingAutoSendRef.current) {
      const text = pendingAutoSendRef.current;
      pendingAutoSendRef.current = null;
      ttsPlayedForResponseRef.current = false;
      handleSendText(text);
    }
  }, [isStreaming]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear UI state on interactive mode transitions
  useEffect(() => {
    if (interactiveMode) {
      setInput('');
    } else {
      setLastTranscript('');
    }
  }, [interactiveMode]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (interactionTimerRef.current) clearTimeout(interactionTimerRef.current);
      if (lastTranscriptTimerRef.current) clearTimeout(lastTranscriptTimerRef.current);
    };
  }, []);

  const toggleShowAdministrator = () => {
    const newValue = !showAdministrator;
    setShowAdministrator(newValue);
    storage.setShowAdministrator(newValue);
  };

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previousScrollHeightRef = useRef<number>(0);
  const streamFrameRef = useRef<number | null>(null);
  const pendingStreamRef = useRef<{ content: string; thinking: string }>({ content: '', thinking: '' });

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

  const prevConversationIdRef = useRef<number | null>(null);
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
  }, [currentConversation]);

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
      if (ttsBufferRef.current.trim()) {
        const cleaned = stripNarration(ttsBufferRef.current);
        if (cleaned) queueText(cleaned, ttsVoiceRef.current);
        ttsBufferRef.current = '';
      }

      // Capture ref values BEFORE mutating — React defers updater execution,
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
    if (event.content) {
      // Content arrived — thinking phase is over
      amplitudeRef.current = { ...amplitudeRef.current, isThinking: false };
    }

    // Streaming TTS auto-play: feed complete sentences to TTS queue
    if (event.content && event.role !== 'tool') {
      ttsVoiceRef.current = event.voice_reference || ttsVoiceRef.current;
      ttsBufferRef.current += event.content;

      // Split on sentence-ending punctuation — all but last segment are complete
      const parts = ttsBufferRef.current.split(/(?<=[.!?。！？\n])\s*/);
      if (parts.length > 1) {
        const batch = parts.slice(0, -1).join(' ');
        ttsBufferRef.current = parts[parts.length - 1];
        if (batch.trim()) {
          const cleaned = stripNarration(batch);
          if (cleaned) queueText(cleaned, ttsVoiceRef.current);
        }
      }
    }
  }, [setCurrentConversationId, scheduleStreamUpdate, queueText, pushAgentCharacterConfig]);

  const handleDone = useCallback((event: DoneEvent) => {
    const state = streamingStateRef.current;

    // Ignore done events for a different conversation
    if (event.conversation_id && state.conversationId && event.conversation_id !== state.conversationId) {
      return;
    }

    // Clear thinking state
    amplitudeRef.current = { ...amplitudeRef.current, isThinking: false };

    // Flush remaining TTS buffer
    if (ttsBufferRef.current.trim()) {
      const cleaned = stripNarration(ttsBufferRef.current);
      if (cleaned) queueText(cleaned, ttsVoiceRef.current);
    }
    ttsBufferRef.current = '';
    ttsVoiceRef.current = undefined;
    // Note: don't clear activeAgentId here — TTS queue still plays after streaming ends.
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
  }, [loadConversation, queueText]);

  const handleError = useCallback((event: ErrorEvent) => {
    console.error('WebSocket error:', event.error);
    setStreamingMessages(prev => {
      if (prev.length === 0) return prev;
      const updated = [...prev];
      updated[updated.length - 1] = {
        ...updated[updated.length - 1],
        content: 'Error: ' + event.error,
      };
      return updated;
    });
    cancelStreamUpdate();
    setStreamingContent('');
    setStreamingThinking('');
    setIsStreaming(false);
  }, []);

  const handleConnected = useCallback((event: ConnectedEvent) => {
    if (event.chat_active && event.conversation_id) {
      // Server has an active streaming task — enter streaming mode and load
      // already-persisted messages (user msg + any completed agent messages)
      if (!isStreamingRef.current) {
        setIsStreaming(true);
        isStreamingRef.current = true;
      }
      loadConversation(event.conversation_id).catch(console.error);
    } else if (!event.chat_active && event.conversation_id) {
      // Task finished while we were disconnected — reload from DB once
      const convId = event.conversation_id;
      loadConversation(convId)
        .then(() => setStreamingMessages([]))
        .catch(console.error);
    }
    // If no conversation_id, nothing to restore
  }, [loadConversation]);

  // Stable refs for WebSocket handlers — avoids re-registering on every render
  // (queueText → playQueue → amplitudeController cascading instability)
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

    wsManager.on('stream_chunk', onChunk);
    wsManager.on('done', onDone);
    wsManager.on('error', onError);
    wsManager.on('connected', onConnected);

    return () => {
      wsManager.off('stream_chunk', onChunk);
      wsManager.off('done', onDone);
      wsManager.off('error', onError);
      wsManager.off('connected', onConnected);
    };
  }, []);

  // Handle scroll to load more messages
  const handleScroll = () => {
    const container = messagesContainerRef.current;
    if (!container || isLoadingMessages || !hasMoreMessages) return;

    if (container.scrollTop < 100) {
      previousScrollHeightRef.current = container.scrollHeight;
      loadMoreMessages();
    }
  };

  const handleSendText = async (overrideText: string) => {
    if (!overrideText.trim() || isStreamingRef.current) return;
    await _doSend(overrideText.trim(), []);
  };

  const handleSend = async () => {
    if (!input.trim() || isStreaming) return;
    const text = input.trim();
    const imageFiles = [...images];
    setInput('');
    setImages([]);
    await _doSend(text, imageFiles);
  };

  const _doSend = async (text: string, imageFiles: File[]) => {
    setIsStreaming(true);

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
  };

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

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setImages([...images, ...Array.from(e.target.files)]);
    }
  };

  const removeImage = (index: number) => {
    setImages(images.filter((_, i) => i !== index));
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleMicToggle = () => {
    if (asrStatus === 'idle') {
      startListening();
    } else {
      stopListening();
    }
  };

  const handleMicContext = (e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault();
    const anchor = e.currentTarget;
    loadAsrDevices().then(() => {
      setMicMenuAnchor(anchor);
    });
  };

  const handleCameraToggle = async () => {
    if (cameraActive) {
      stopVision();
    } else {
      if (cameraWebcams.length === 0) await loadCameraWebcams();
      startVision();
    }
  };

  const handleCameraContext = (e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault();
    const anchor = e.currentTarget;
    loadCameraWebcams().then(() => {
      setCameraMenuAnchor(anchor);
    });
  };

  const toggleThinking = (index: number) => {
    setExpandedThinking(prev => {
      const newSet = new Set(prev);
      if (newSet.has(index)) {
        newSet.delete(index);
      } else {
        newSet.add(index);
      }
      return newSet;
    });
  };

  const handleDelete = async (messageIndex: number) => {
    const combined = [...messages, ...streamingMessages];
    const filtered = combined.filter((message) => {
      const speakerName = message.name || message.agent?.name;
      return speakerName !== 'Administrator' || showAdministrator;
    });
    const message = filtered[messageIndex];
    if (!message?.id || !activeConversationId) return;

    try {
      await apiClient.deleteMessage(message.id);
      await loadConversation(activeConversationId);
    } catch (e) {
      console.error('Failed to delete message:', e);
    }
  };

  const handleResend = async (messageIndex: number) => {
    if (isStreaming) return;

    const combined = [...messages, ...streamingMessages];
    const filtered = combined.filter((message) => {
      const speakerName = message.name || message.agent?.name;
      return speakerName !== 'Administrator' || showAdministrator;
    });
    const message = filtered[messageIndex];
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
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, height: '100%' }}>

      {/* Messages area */}
      <Box
        ref={messagesContainerRef}
        onScroll={handleScroll}
        sx={{
          flex: 1,
          overflow: 'auto',
          p: 3,
          backgroundColor: '#F8FAFC',
        }}
      >
        {/* Administrator visibility toggle — hidden in single agent mode */}
        {!agentId && (
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
            <Tooltip title={showAdministrator ? 'Hide Administrator messages' : 'Show Administrator messages'}>
              <IconButton
                size="small"
                onClick={toggleShowAdministrator}
                sx={{ opacity: 0.6, '&:hover': { opacity: 1 } }}
              >
                {showAdministrator ? <VisibilityIcon fontSize="small" /> : <VisibilityOffIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          </Box>
        )}

        {isLoadingMessages && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <Typography variant="body2" color="text.secondary">
              Loading earlier messages...
            </Typography>
          </Box>
        )}

        <AnimatePresence>
          {(() => {
            const combined = [...messages, ...streamingMessages];
            // The active streaming message is the last one in streamingMessages
            const activeStreamingMsg = isStreaming && streamingMessages.length > 0
              ? streamingMessages[streamingMessages.length - 1]
              : null;
            const filtered = combined.filter((message) => {
              const speakerName = message.name || message.agent?.name;
              if (speakerName === 'Administrator' && !showAdministrator) {
                return false;
              }
              return true;
            });

            const elements: React.ReactNode[] = [];
            let lastFrameId: number | undefined;

            filtered.forEach((message, index) => {
              const currentFrameId = message.frame_id;
              // Insert separator when frame changes (not before first message)
              if (currentFrameId && currentFrameId !== lastFrameId && lastFrameId !== undefined) {
                const frameInfo = frames[currentFrameId];
                if (frameInfo) {
                  elements.push(
                    <FrameSeparator key={`frame-sep-${currentFrameId}`} frame={frameInfo} />
                  );
                }
              }
              lastFrameId = currentFrameId;

              const isActiveStreaming = message === activeStreamingMsg;
              elements.push(
                <MessageBubble
                  key={message.id ? `msg-${message.id}` : `stream-${index}`}
                  message={message}
                  index={index}
                  isLast={index === filtered.length - 1}
                  isStreaming={isActiveStreaming}
                  streamingThinking={isActiveStreaming ? streamingThinking : ''}
                  streamingContent={isActiveStreaming ? streamingContent : ''}
                  displayedThinking={isActiveStreaming ? streamingThinking : ''}
                  displayedContent={isActiveStreaming ? streamingContent : ''}
                  justFinishedStreaming={index === filtered.length - 1 && justFinishedStreaming}
                  expandedThinking={expandedThinking}
                  onToggleThinking={toggleThinking}
                  onResend={handleResend}
                  onDelete={handleDelete}
                  ttsRef={ttsRef}
                />
              );
            });

            return elements;
          })()}
        </AnimatePresence>
        <div ref={messagesEndRef} />
      </Box>

      {/* Bottom area: interactive call bar or typing input */}
      {interactiveMode ? (
        <InteractiveCallBar
          asrStatus={asrStatus}
          interactionActive={interactionActive}
          lastTranscript={lastTranscript}
          isStreaming={isStreaming}
          isTTSPlaying={isQueueActive}
          onHangUp={disableInteractiveMode}
        />
      ) : (
        <Paper
          elevation={3}
          sx={{
            p: 2,
            borderTop: '1px solid',
            borderColor: 'divider',
          }}
        >
          {images.length > 0 && (
            <Box sx={{ mb: 1, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              {images.map((img, index) => (
                <Chip
                  key={index}
                  label={img.name}
                  onDelete={() => removeImage(index)}
                  deleteIcon={<CloseIcon />}
                  size="small"
                />
              ))}
            </Box>
          )}

          <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-end' }}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={handleFileSelect}
            />
            <IconButton
              onClick={() => fileInputRef.current?.click()}
              disabled={isStreaming}
            >
              <AttachFileIcon />
            </IconButton>

            <Tooltip title={asrStatus === 'idle' ? 'Start dictation (right-click: select mic)' : 'Stop dictation'}>
              <IconButton
                onClick={handleMicToggle}
                onContextMenu={handleMicContext}
                disabled={isStreaming}
                sx={{
                  color: asrStatus === 'listening' ? 'error.main' : 'inherit',
                }}
              >
                {asrStatus === 'processing' ? (
                  <CircularProgress size={24} />
                ) : asrStatus === 'listening' ? (
                  <MicIcon />
                ) : (
                  <MicOffIcon />
                )}
              </IconButton>
            </Tooltip>
            <Menu
              anchorEl={micMenuAnchor}
              open={Boolean(micMenuAnchor)}
              onClose={() => setMicMenuAnchor(null)}
            >
              {asrDevices.map((device) => (
                <MenuItem
                  key={device.deviceId}
                  onClick={() => {
                    selectAsrDevice(device.deviceId);
                    setMicMenuAnchor(null);
                  }}
                  selected={device.deviceId === asrDeviceId}
                >
                  {device.deviceId === asrDeviceId && (
                    <ListItemIcon><CheckIcon fontSize="small" /></ListItemIcon>
                  )}
                  <ListItemText inset={device.deviceId !== asrDeviceId}>
                    {device.label}
                  </ListItemText>
                </MenuItem>
              ))}
              {asrDevices.length === 0 && (
                <MenuItem disabled>No microphones found</MenuItem>
              )}
            </Menu>

            <Tooltip title={cameraActive ? 'Stop camera (right-click: select webcam)' : 'Start camera (right-click: select webcam)'}>
              <IconButton
                onClick={handleCameraToggle}
                onContextMenu={handleCameraContext}
                disabled={isStreaming}
                sx={{
                  color: cameraActive ? 'success.main' : 'inherit',
                  animation: cameraActive ? 'pulse 1.5s infinite' : 'none',
                  '@keyframes pulse': {
                    '0%': { opacity: 1 },
                    '50%': { opacity: 0.5 },
                    '100%': { opacity: 1 },
                  },
                }}
              >
                {cameraActive ? <VideocamIcon /> : <VideocamOffIcon />}
              </IconButton>
            </Tooltip>
            <Menu
              anchorEl={cameraMenuAnchor}
              open={Boolean(cameraMenuAnchor)}
              onClose={() => setCameraMenuAnchor(null)}
            >
              {cameraWebcams.map((cam) => (
                <MenuItem
                  key={cam}
                  onClick={() => {
                    setCameraSelectedWebcam(cam);
                    setCameraMenuAnchor(null);
                  }}
                  selected={cam === cameraSelectedWebcam}
                >
                  {cam === cameraSelectedWebcam && (
                    <ListItemIcon><CheckIcon fontSize="small" /></ListItemIcon>
                  )}
                  <ListItemText inset={cam !== cameraSelectedWebcam}>
                    {cam}
                  </ListItemText>
                </MenuItem>
              ))}
              {cameraWebcams.length === 0 && (
                <MenuItem disabled>No webcams found</MenuItem>
              )}
            </Menu>

            <TextField
              fullWidth
              multiline
              maxRows={4}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="Type your message..."
              disabled={isStreaming}
            />

            {isStreaming ? (
              <Button
                variant="contained"
                color="error"
                endIcon={<StopIcon />}
                onClick={handleCancel}
                sx={{ minWidth: 100 }}
              >
                Stop
              </Button>
            ) : (
              <Button
                variant="contained"
                endIcon={<SendIcon />}
                onClick={handleSend}
                disabled={!input.trim()}
                sx={{ minWidth: 100 }}
              >
                Send
              </Button>
            )}
          </Box>
        </Paper>
      )}
    </Box>
  );
};

// Strip action narration (*action text*) from TTS input, preserving **bold**
function stripNarration(text: string): string {
  return text.replace(/(?<!\*)\*(?!\*)([^*]+)\*(?!\*)/g, '').replace(/\s{2,}/g, ' ').trim();
}

// Helper function to convert File to base64
async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      // Remove the data URL prefix (e.g., "data:image/png;base64,")
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
  });
}
