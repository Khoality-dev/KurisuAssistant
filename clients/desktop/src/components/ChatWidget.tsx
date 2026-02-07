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
} from '@mui/material';
import {
  Send as SendIcon,
  AttachFile as AttachFileIcon,
  Close as CloseIcon,
  Visibility as VisibilityIcon,
  VisibilityOff as VisibilityOffIcon,
  Stop as StopIcon,
} from '@mui/icons-material';
import { AnimatePresence } from 'framer-motion';
import { useConversationStore } from '../store/conversationStore';
import { wsManager, StreamChunkEvent, DoneEvent, ErrorEvent, BaseEvent } from '../api/websocket';
import { storage } from '../utils/storage';
import { useTTS } from '../hooks/useTTS';
import { MessageBubble } from './MessageBubble';
import type { Message } from '../api/types';

export const ChatWidget: React.FC = () => {
  const {
    messages,
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

  // Streaming TTS auto-play
  const { queueText, clearQueue } = useTTS();
  const ttsBufferRef = useRef('');
  const ttsVoiceRef = useRef<string | undefined>(undefined);

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

  useEffect(() => {
    setActiveConversationId(currentConversation?.id || null);
    // Clear local streaming state when conversation changes
    setStreamingMessages([]);
    setStreamingContent('');
    setStreamingThinking('');
    setJustFinishedStreaming(false);
    setIsStreaming(false);
    isStreamingRef.current = false;
    cancelStreamUpdate();
    // Clear TTS queue on conversation switch
    clearQueue();
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
      conversationId: currentConversation?.id || null,
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
      setCurrentConversationId(event.conversation_id).catch(console.error);
    }

    const messageRole = event.role;
    const agentName = event.agent_name || undefined;
    const agentId = event.agent_id ?? undefined;

    // Check if we need to create a new bubble:
    // - Role changed (user -> assistant -> tool)
    // - Agent changed (Administrator -> Agent1 -> Administrator) - compare by name since admin may not have ID
    const roleChanged = state.currentRole && messageRole !== state.currentRole;
    const agentChanged = state.hasStarted && state.currentAgentName !== agentName;
    const needsNewBubble = roleChanged || agentChanged;

    if (needsNewBubble) {
      // Flush TTS buffer from previous agent before switching
      if (storage.getTTSAutoPlay() && ttsBufferRef.current.trim()) {
        queueText(ttsBufferRef.current.trim(), ttsVoiceRef.current);
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
          agent_name: agentName,
          agent_id: agentId,
          voice_reference: event.voice_reference || undefined,
        });
        return updated;
      });

      state.currentRole = messageRole;
      state.currentAgentId = agentId;
      state.currentAgentName = agentName;
      state.accumulatedContent = event.content || '';
      state.accumulatedThinking = '';

      // Update TTS voice for new agent
      ttsVoiceRef.current = event.voice_reference || undefined;

      scheduleStreamUpdate(state.accumulatedContent, state.accumulatedThinking);
    } else if (!state.hasStarted) {
      // First message chunk - update placeholder bubble
      state.hasStarted = true;
      state.currentRole = messageRole;
      state.currentAgentId = agentId;
      state.currentAgentName = agentName;
      state.accumulatedContent = event.content || '';
      state.accumulatedThinking = '';

      if (state.hasPlaceholder) {
        // Update placeholder with actual role/agent info
        setStreamingMessages(prev => {
          const updated = [...prev];
          if (updated.length > 0) {
            updated[updated.length - 1] = {
              ...updated[updated.length - 1],
              role: messageRole,
              agent_name: agentName,
              agent_id: agentId,
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
          agent_name: agentName,
          agent_id: agentId,
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

    // Always accumulate thinking
    if (event.thinking) {
      state.accumulatedThinking += event.thinking;
      scheduleStreamUpdate(state.accumulatedContent, state.accumulatedThinking);
    }

    // Streaming TTS auto-play: feed complete sentences to TTS queue
    if (storage.getTTSAutoPlay() && event.content && event.role !== 'tool') {
      ttsVoiceRef.current = event.voice_reference || ttsVoiceRef.current;
      ttsBufferRef.current += event.content;

      // Split on sentence-ending punctuation — all but last segment are complete
      const parts = ttsBufferRef.current.split(/(?<=[.!?。！？\n])\s*/);
      if (parts.length > 1) {
        const batch = parts.slice(0, -1).join(' ');
        ttsBufferRef.current = parts[parts.length - 1];
        if (batch.trim()) {
          queueText(batch, ttsVoiceRef.current);
        }
      }
    }
  }, [setCurrentConversationId, scheduleStreamUpdate, queueText]);

  const handleDone = useCallback((event: DoneEvent) => {
    const state = streamingStateRef.current;

    // Ignore done events for a different conversation
    if (event.conversation_id && state.conversationId && event.conversation_id !== state.conversationId) {
      return;
    }

    // Flush remaining TTS buffer
    if (storage.getTTSAutoPlay() && ttsBufferRef.current.trim()) {
      queueText(ttsBufferRef.current.trim(), ttsVoiceRef.current);
    }
    ttsBufferRef.current = '';
    ttsVoiceRef.current = undefined;

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

  const handleReconnected = useCallback((_event: BaseEvent) => {
    console.log('[ChatWidget] WebSocket reconnected, reloading conversation');
    const convId = activeConversationId || streamingStateRef.current.conversationId;
    if (convId) {
      // Reload immediately to show whatever is saved
      const reload = () => loadConversation(convId)
        .then(() => setStreamingMessages([]))
        .catch(console.error);

      reload();
      // Retry after delays to catch messages saved while disconnected
      setTimeout(reload, 3000);
      setTimeout(reload, 8000);
    }
  }, [activeConversationId, loadConversation]);

  // Set up WebSocket event listeners
  useEffect(() => {
    wsManager.on('stream_chunk', handleStreamChunk);
    wsManager.on('done', handleDone);
    wsManager.on('error', handleError);
    wsManager.on('reconnected', handleReconnected);

    return () => {
      wsManager.off('stream_chunk', handleStreamChunk);
      wsManager.off('done', handleDone);
      wsManager.off('error', handleError);
      wsManager.off('reconnected', handleReconnected);
    };
  }, [handleStreamChunk, handleDone, handleError, handleReconnected]);

  // Handle scroll to load more messages
  const handleScroll = () => {
    const container = messagesContainerRef.current;
    if (!container || isLoadingMessages || !hasMoreMessages) return;

    if (container.scrollTop < 100) {
      previousScrollHeightRef.current = container.scrollHeight;
      loadMoreMessages();
    }
  };

  const handleSend = async () => {
    if (!input.trim() || isStreaming) return;

    setIsStreaming(true);

    // Clear any previous TTS queue
    clearQueue();
    ttsBufferRef.current = '';
    ttsVoiceRef.current = undefined;

    try {
      // Upload images first and get UUIDs
      const imageFiles = images;
      const imageBase64: string[] = [];
      for (const imageFile of imageFiles) {
        // Convert to base64 for WebSocket
        const base64 = await fileToBase64(imageFile);
        imageBase64.push(base64);
      }

      const userMessage: Message = {
        role: 'user',
        content: input,
        images: [], // Will be handled differently
      };

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

      setInput('');
      setImages([]);
      setStreamingContent('');
      setStreamingThinking('');
      setJustFinishedStreaming(false);

      // Send via WebSocket
      await wsManager.sendChatRequest(
        userMessage.content,
        '', // Model determined by backend
        activeConversationId,
        null, // agent_id - let Administrator route
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

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

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
        {/* Administrator visibility toggle */}
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
              const agentName = message.agent?.name || message.agent_name;
              if (agentName === 'Administrator' && !showAdministrator) {
                return false;
              }
              return true;
            });
            return filtered.map((message, index, arr) => {
              // Match by object identity to find the actual streaming message
              const isActiveStreaming = message === activeStreamingMsg;
              return (
                <MessageBubble
                  key={message.id ? `msg-${message.id}` : `stream-${index}`}
                  message={message}
                  index={index}
                  isLast={index === arr.length - 1}
                  isStreaming={isActiveStreaming}
                  streamingThinking={isActiveStreaming ? streamingThinking : ''}
                  streamingContent={isActiveStreaming ? streamingContent : ''}
                  displayedThinking={isActiveStreaming ? streamingThinking : ''}
                  displayedContent={isActiveStreaming ? streamingContent : ''}
                  justFinishedStreaming={index === arr.length - 1 && justFinishedStreaming}
                  expandedThinking={expandedThinking}
                  onToggleThinking={toggleThinking}
                />
              );
            });
          })()}
        </AnimatePresence>
        <div ref={messagesEndRef} />
      </Box>

      {/* Input area */}
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
    </Box>
  );
};

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
