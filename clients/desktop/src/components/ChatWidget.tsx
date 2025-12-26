import React, { useState, useEffect, useRef } from 'react';
import {
  Box,
  TextField,
  Button,
  IconButton,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Paper,
  Typography,
  Chip,
} from '@mui/material';
import {
  Send as SendIcon,
  AttachFile as AttachFileIcon,
  Close as CloseIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import { AnimatePresence } from 'framer-motion';
import { useConversationStore } from '../store/conversationStore';
import { apiClient } from '../api/client';
import { storage } from '../utils/storage';
import { MessageBubble } from './MessageBubble';
import type { Message } from '../api/types';

export const ChatWidget: React.FC = () => {
  const {
    messages,
    models,
    selectedModel,
    currentConversation,
    hasMoreMessages,
    isLoadingMessages,
    loadModels,
    loadMoreMessages,
    setSelectedModel,
    addMessage,
    updateLastMessage,
    setCurrentConversationId,
  } = useConversationStore();

  const [input, setInput] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingThinking, setStreamingThinking] = useState('');
  const [displayedContent, setDisplayedContent] = useState(''); // For typing effect
  const [displayedThinking, setDisplayedThinking] = useState(''); // For typing effect
  const [justFinishedStreaming, setJustFinishedStreaming] = useState(false);
  const [expandedThinking, setExpandedThinking] = useState<Set<number>>(new Set()); // Track which messages have thinking expanded
  const [activeConversationId, setActiveConversationId] = useState<number | null>(
    currentConversation?.id || null
  );
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previousScrollHeightRef = useRef<number>(0);
  const typingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const streamFrameRef = useRef<number | null>(null);
  const pendingStreamRef = useRef<{ content: string; thinking: string }>({ content: '', thinking: '' });

  const cancelStreamUpdate = () => {
    if (streamFrameRef.current !== null) {
      cancelAnimationFrame(streamFrameRef.current);
      streamFrameRef.current = null;
    }
  };

  const scheduleStreamUpdate = (content: string, thinking: string) => {
    pendingStreamRef.current = { content, thinking };
    if (streamFrameRef.current === null) {
      streamFrameRef.current = requestAnimationFrame(() => {
        const next = pendingStreamRef.current;
        setStreamingContent(next.content);
        setStreamingThinking(next.thinking);
        streamFrameRef.current = null;
      });
    }
  };

  // Sequential typing effect: thinking first, then content
  const startSequentialTypingEffect = () => {
    if (typingIntervalRef.current) {
      clearInterval(typingIntervalRef.current);
      typingIntervalRef.current = null;
    }

    typingIntervalRef.current = setInterval(() => {
      setDisplayedThinking((prevThinking) => {
        // First, type out thinking
        if (prevThinking.length < streamingThinking.length) {
          return streamingThinking.slice(0, prevThinking.length + 2);
        }

        // Thinking is done, now type content
        setDisplayedContent((prevContent) => {
          if (prevContent.length < streamingContent.length) {
            return streamingContent.slice(0, prevContent.length + 2);
          }
          // Both done, clear interval
          if (typingIntervalRef.current) {
            clearInterval(typingIntervalRef.current);
            typingIntervalRef.current = null;
          }
          return prevContent;
        });

        return prevThinking;
      });
    }, 20);
  };

  useEffect(() => {
    loadModels().catch(console.error);
  }, [loadModels]);

  // Load selected model from localStorage on mount
  useEffect(() => {
    const savedModel = storage.getSelectedModel();
    if (savedModel && models.includes(savedModel)) {
      setSelectedModel(savedModel);
    }
  }, [models, setSelectedModel]);

  // Save selected model to localStorage whenever it changes
  useEffect(() => {
    if (selectedModel) {
      storage.setSelectedModel(selectedModel);
    }
  }, [selectedModel]);

  useEffect(() => {
    setActiveConversationId(currentConversation?.id || null);
  }, [currentConversation]);

  // Sequential typing effect - thinking first, then content
  useEffect(() => {
    if (!isStreaming) {
      // Not streaming, clear any typing effects
      if (typingIntervalRef.current) {
        clearInterval(typingIntervalRef.current);
        typingIntervalRef.current = null;
      }
      return;
    }

    // Reset and start sequential typing when streaming data changes
    if (streamingThinking === '' && streamingContent === '') {
      setDisplayedThinking('');
      setDisplayedContent('');
    } else {
      startSequentialTypingEffect();
    }

    return () => {
      if (typingIntervalRef.current) {
        clearInterval(typingIntervalRef.current);
        typingIntervalRef.current = null;
      }
    };
  }, [streamingThinking, streamingContent, isStreaming]);

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

  // Scroll to bottom on new messages (but not when loading more old messages)
  useEffect(() => {
    if (!isLoadingMessages) {
      messagesEndRef.current?.scrollIntoView({ behavior: isStreaming ? 'auto' : 'smooth' });
    }
  }, [messages, displayedContent, isLoadingMessages, isStreaming]);

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

  // Handle scroll to load more messages
  const handleScroll = () => {
    const container = messagesContainerRef.current;
    if (!container || isLoadingMessages || !hasMoreMessages) return;

    // If user scrolled near the top (within 100px), load more
    if (container.scrollTop < 100) {
      previousScrollHeightRef.current = container.scrollHeight;
      loadMoreMessages();
    }
  };

  const handleSend = async () => {
    if (!input.trim() || isStreaming || !selectedModel) return;

    setIsStreaming(true);

    try {
      // Upload images first and get UUIDs
      const imageFiles = images; // Keep reference before clearing
      const imageUuids: string[] = [];
      for (const imageFile of imageFiles) {
        const result = await apiClient.uploadImage(imageFile);
        imageUuids.push(result.image_uuid);
      }

      const userMessage: Message = {
        role: 'user',
        content: input,
        images: imageUuids,
      };

      addMessage(userMessage);
      addMessage({ role: 'assistant', content: '' });
      setInput('');
      setImages([]);
      setStreamingContent('');
      setStreamingThinking('');
      setDisplayedContent(''); // Reset typing effect
      setDisplayedThinking('');
      setJustFinishedStreaming(false); // Clear previous "done" indicator

      // Will start with empty message from backend
      let currentRole: string | null = null;
      let hasPlaceholder = true;
      let accumulatedContent = '';
      let accumulatedThinking = ''; // Track thinking

      const stream = apiClient.chatStream(
        userMessage.content,
        selectedModel,
        activeConversationId,
        imageFiles
      );

      let streamConversationId = activeConversationId;

      for await (const chunk of stream) {
        if (chunk.conversation_id && !streamConversationId) {
          streamConversationId = chunk.conversation_id;
          setActiveConversationId(chunk.conversation_id);
          // Notify store to refresh conversation list if this is a new conversation
          setCurrentConversationId(chunk.conversation_id).catch(console.error);
        }

        // Handle "done" signal from backend
        if (chunk.done) {
          // When streaming ends, update the store with final content and thinking
          if (accumulatedContent || accumulatedThinking) {
            updateLastMessage(accumulatedContent, accumulatedThinking || undefined);
          }

          // Brief delay before showing "done" indicator and clearing streaming state
          setTimeout(() => {
            cancelStreamUpdate();
            setStreamingContent('');
            setStreamingThinking('');
            setJustFinishedStreaming(true);
          }, 300);
          break; // Exit the loop when done
        }

        // Handle message chunks
        if (chunk.message) {
          const messageRole = chunk.message.role;

          // If role changes (e.g., assistant -> tool, or assistant -> agent), create new message
          if (currentRole && messageRole !== currentRole) {
            // Finalize previous message
            updateLastMessage(accumulatedContent, accumulatedThinking || undefined);

            // Start new message for different role (empty content initially)
            const newMessage: Message = {
              role: messageRole,
              content: '' // Start empty - will display from streaming state
            };
            addMessage(newMessage);
            currentRole = messageRole;
            accumulatedContent = chunk.message.content || '';
            accumulatedThinking = '';
            setDisplayedThinking('');

            // Update streaming content immediately
            scheduleStreamUpdate(accumulatedContent, accumulatedThinking);
          } else if (!currentRole) {
            // First message chunk - reuse placeholder bubble
            currentRole = messageRole;
            accumulatedContent = chunk.message.content || '';
            accumulatedThinking = '';
            setDisplayedThinking('');

            if (hasPlaceholder) {
              updateLastMessage(accumulatedContent, accumulatedThinking || undefined, messageRole);
              hasPlaceholder = false;
            } else {
              const firstMessage: Message = {
                role: messageRole,
                content: '' // Start empty - will display from streaming state
              };
              addMessage(firstMessage);
            }

            // Update streaming content immediately
            scheduleStreamUpdate(accumulatedContent, accumulatedThinking);
          } else {
            // Same role, accumulate content
            if (chunk.message.content) {
              accumulatedContent += chunk.message.content;
              scheduleStreamUpdate(accumulatedContent, accumulatedThinking);
            }
          }

          // Always accumulate thinking regardless of role logic (simple append to thinking section)
          if (chunk.message.thinking) {
            accumulatedThinking += chunk.message.thinking;
            scheduleStreamUpdate(accumulatedContent, accumulatedThinking);
          }
        }
      }
    } catch (err: any) {
      console.error('Chat error:', err);
      // Only update if we have a message to update
      if (messages.length > 0) {
        updateLastMessage('Error: ' + (err.message || 'Failed to send message'));
      }
      cancelStreamUpdate();
      setStreamingContent('');
      setStreamingThinking('');
    } finally {
      setIsStreaming(false);
    }
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
      {/* Top bar with model selector */}
      <Paper
        elevation={0}
        sx={{
          p: 2,
          borderBottom: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          gap: 2,
        }}
      >
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel>Model</InputLabel>
          <Select
            value={selectedModel}
            label="Model"
            onChange={(e) => setSelectedModel(e.target.value)}
          >
            {models.map((model) => (
              <MenuItem key={model} value={model}>
                {model}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <IconButton
          onClick={() => loadModels()}
          size="small"
          title="Reload models"
          sx={{ color: 'primary.main' }}
        >
          <RefreshIcon />
        </IconButton>
      </Paper>

      {/* Messages area */}
      <Box
        ref={messagesContainerRef}
        onScroll={handleScroll}
        sx={{
          flex: 1,
          overflow: 'auto',
          p: 3,
          backgroundColor: '#F7F7F8',
        }}
      >
        {isLoadingMessages && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <Typography variant="body2" color="text.secondary">
              Loading earlier messages...
            </Typography>
          </Box>
        )}

        <AnimatePresence>
          {messages.map((message, index) => (
            <MessageBubble
              key={index}
              message={message}
              index={index}
              isLast={index === messages.length - 1}
              isStreaming={isStreaming}
              streamingThinking={streamingThinking}
              streamingContent={streamingContent}
              displayedThinking={displayedThinking}
              displayedContent={displayedContent}
              justFinishedStreaming={justFinishedStreaming}
              expandedThinking={expandedThinking}
              onToggleThinking={toggleThinking}
            />
          ))}
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

          <Button
            variant="contained"
            endIcon={<SendIcon />}
            onClick={handleSend}
            disabled={!input.trim() || isStreaming || !selectedModel}
            sx={{ minWidth: 100 }}
          >
            Send
          </Button>
        </Box>
      </Paper>
    </Box>
  );
};
