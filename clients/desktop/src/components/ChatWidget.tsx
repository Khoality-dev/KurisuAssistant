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
  CheckCircle as CheckCircleIcon,
  Refresh as RefreshIcon,
  Psychology as PsychologyIcon,
  ExpandMore as ExpandMoreIcon,
} from '@mui/icons-material';
import { motion, AnimatePresence } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import { useConversationStore } from '../store/conversationStore';
import { apiClient } from '../api/client';
import { config } from '../config';
import { storage } from '../utils/storage';
import type { Message } from '../api/types';

interface ChatWidgetProps {
  onConversationCreated: () => void;
}

const MotionBox = motion(Box);

export const ChatWidget: React.FC<ChatWidgetProps> = ({ onConversationCreated }) => {
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
  const [displayedContent, setDisplayedContent] = useState(''); // For typing effect
  const [justFinishedStreaming, setJustFinishedStreaming] = useState(false);
  const [expandedThinking, setExpandedThinking] = useState<Set<number>>(new Set()); // Track which messages have thinking expanded
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previousScrollHeightRef = useRef<number>(0);
  const typingIntervalRef = useRef<NodeJS.Timeout | null>(null);

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

  // Typing effect - display characters one by one
  useEffect(() => {
    // Clear any existing interval
    if (typingIntervalRef.current) {
      clearInterval(typingIntervalRef.current);
      typingIntervalRef.current = null;
    }

    // If streaming content is longer than displayed content, start typing
    if (streamingContent.length > displayedContent.length) {
      typingIntervalRef.current = setInterval(() => {
        setDisplayedContent((prev) => {
          if (prev.length < streamingContent.length) {
            // Display 2 characters at a time for faster typing
            return streamingContent.slice(0, prev.length + 2);
          }
          // Finished typing
          if (typingIntervalRef.current) {
            clearInterval(typingIntervalRef.current);
            typingIntervalRef.current = null;
          }
          return prev;
        });
      }, 20); // 20ms interval for smooth typing effect
    } else if (streamingContent === '' && displayedContent !== '') {
      // Reset when streaming content is cleared
      setDisplayedContent('');
    }

    return () => {
      if (typingIntervalRef.current) {
        clearInterval(typingIntervalRef.current);
        typingIntervalRef.current = null;
      }
    };
  }, [streamingContent]);

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
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, displayedContent, isLoadingMessages]);

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
      setInput('');
      setImages([]);
      setStreamingContent('');
      setDisplayedContent(''); // Reset typing effect
      setJustFinishedStreaming(false); // Clear previous "done" indicator

      // Will start with empty message from backend
      let currentRole: string | null = null;
      let accumulatedContent = '';
      let accumulatedThinking = ''; // Track thinking

      console.log('[ChatWidget] Starting stream...');

      const stream = apiClient.chatStream(
        userMessage.content,
        selectedModel,
        currentConversation?.id || null,
        imageFiles
      );

      for await (const chunk of stream) {
        console.log('[ChatWidget] Received chunk:', chunk);

        // Handle conversation creation
        if (chunk.conversation_id && !currentConversation) {
          console.log('[ChatWidget] Setting conversation ID:', chunk.conversation_id);
          setCurrentConversationId(chunk.conversation_id);
          onConversationCreated();
        }

        // Handle "done" signal from backend
        if (chunk.done) {
          console.log('[ChatWidget] Received DONE signal from backend');
          // When streaming ends, update the store with final content and thinking
          if (accumulatedContent || accumulatedThinking) {
            const finalMessage: Partial<Message> = { content: accumulatedContent };
            if (accumulatedThinking) {
              finalMessage.thinking = accumulatedThinking;
            }
            updateLastMessage(accumulatedContent);
            // Update the last message with thinking if present
            if (accumulatedThinking && messages.length > 0) {
              const lastMessage = messages[messages.length - 1];
              lastMessage.thinking = accumulatedThinking;
            }
            console.log('[ChatWidget] Updated last message in store with final content and thinking');
          }

          // Brief delay before showing "done" indicator and clearing streaming state
          setTimeout(() => {
            setStreamingContent('');
            setJustFinishedStreaming(true);
            console.log('[ChatWidget] Cleared streaming state, showing done indicator');
          }, 300);
          break; // Exit the loop when done
        }

        // Handle message chunks
        if (chunk.message) {
          const messageRole = chunk.message.role;
          console.log('[ChatWidget] Message role:', messageRole, 'Content:', chunk.message.content);

          // If role changes (e.g., assistant -> tool, or assistant -> agent), create new message
          if (currentRole && messageRole !== currentRole) {
            console.log('[ChatWidget] Role changed from', currentRole, 'to', messageRole);
            // Finalize previous message
            if (accumulatedContent) {
              updateLastMessage(accumulatedContent);
            }

            // Start new message for different role (empty content initially)
            const newMessage: Message = {
              role: messageRole,
              content: '' // Start empty - will display from streaming state
            };
            addMessage(newMessage);
            currentRole = messageRole;
            accumulatedContent = chunk.message.content || '';

            // Update streaming content immediately
            setStreamingContent(accumulatedContent);
            console.log('[ChatWidget] Set streaming content (new role):', accumulatedContent);
          } else if (!currentRole) {
            console.log('[ChatWidget] First message chunk, role:', messageRole);
            // First message chunk - create initial message (empty content initially)
            const firstMessage: Message = {
              role: messageRole,
              content: '' // Start empty - will display from streaming state
            };
            addMessage(firstMessage);
            currentRole = messageRole;
            accumulatedContent = chunk.message.content || '';

            // Update streaming content immediately
            setStreamingContent(accumulatedContent);
            console.log('[ChatWidget] Set streaming content (first):', accumulatedContent);
          } else {
            // Same role, accumulate content
            if (chunk.message.content) {
              accumulatedContent += chunk.message.content;
              setStreamingContent(accumulatedContent);
              console.log('[ChatWidget] Accumulated content length:', accumulatedContent.length);
            }
          }

          // Always accumulate thinking regardless of role logic (simple append to thinking section)
          if (chunk.message.thinking) {
            accumulatedThinking += chunk.message.thinking;
            console.log('[ChatWidget] Accumulated thinking, length:', accumulatedThinking.length);
          }
        }
      }

      console.log('[ChatWidget] Stream ended, final content length:', accumulatedContent.length);
    } catch (err: any) {
      console.error('Chat error:', err);
      // Only update if we have a message to update
      if (messages.length > 0) {
        updateLastMessage('Error: ' + (err.message || 'Failed to send message'));
      }
      setStreamingContent('');
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
          {messages.map((message, index) => {
            const isLast = index === messages.length - 1;
            const isStreamingThisMessage = isLast && message.role !== 'user' && isStreaming;
            const showFinishedIndicator = isLast && message.role !== 'user' && justFinishedStreaming && !isStreaming;

            // IMPORTANT: During streaming, display from typing effect (displayedContent), NOT from database (message.content)
            // This ensures we show live-generated content with typing animation
            const displayContent = isStreamingThisMessage ? displayedContent : message.content;

            console.log('[ChatWidget] Rendering message', index, 'isStreamingThisMessage:', isStreamingThisMessage, 'displayContent length:', displayContent?.length);

            // Determine message styling based on role
            const isUser = message.role === 'user';

            // Use role name for label (capitalize first letter)
            const label = isUser
              ? 'You'
              : message.role.charAt(0).toUpperCase() + message.role.slice(1);

            // Color scheme for different roles
            const getColorScheme = () => {
              if (isUser) {
                return {
                  bg: '#FFFFFF',
                  border: '#E5E5E5',
                  label: 'text.primary'
                };
              }
              // For all non-user roles (assistant, tool, agents, etc.)
              switch (message.role) {
                case 'tool':
                  return {
                    bg: '#FFF8E1',
                    border: '#FFB74D',
                    label: '#F57C00'
                  };
                case 'assistant':
                default:
                  return {
                    bg: '#F0FDF9',
                    border: '#10A37F33',
                    label: 'primary.main'
                  };
              }
            };

            const colorScheme = getColorScheme();

            return (
              <MotionBox
                key={index}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
                sx={{
                  mb: 2,
                  display: 'flex',
                  justifyContent: isUser ? 'flex-end' : 'flex-start',
                }}
              >
                <Paper
                  elevation={0}
                  sx={{
                    maxWidth: '80%',
                    p: 2,
                    backgroundColor: colorScheme.bg,
                    border: '1px solid',
                    borderColor: colorScheme.border,
                  }}
                >
                  <Typography
                    variant="caption"
                    sx={{
                      fontWeight: 600,
                      color: colorScheme.label,
                      mb: 1,
                      display: 'block',
                    }}
                  >
                    {label}
                  </Typography>
                  <Box
                    sx={{
                      '& p': { margin: 0, marginBottom: 1 },
                      '& p:last-child': { marginBottom: 0 },
                      '& code': {
                        backgroundColor: '#F3F4F6',
                        padding: '2px 6px',
                        borderRadius: 1,
                        fontFamily: 'Consolas, Monaco, monospace',
                        fontSize: '0.875em',
                      },
                      '& pre': {
                        backgroundColor: '#F3F4F6',
                        padding: 2,
                        borderRadius: 1,
                        overflow: 'auto',
                      },
                    }}
                  >
                    {/* Thinking Section - Show FIRST */}
                    {(message.thinking || isStreamingThisMessage) && (
                      <Box sx={{ mb: displayContent || message.images ? 1 : 0, pb: displayContent || message.images ? 1 : 0, borderBottom: displayContent || message.images ? '1px solid' : 'none', borderColor: 'divider' }}>
                        <Button
                          size="small"
                          startIcon={<PsychologyIcon />}
                          endIcon={
                            <ExpandMoreIcon
                              sx={{
                                transform: expandedThinking.has(index) ? 'rotate(180deg)' : 'rotate(0deg)',
                                transition: 'transform 0.2s',
                              }}
                            />
                          }
                          onClick={() => toggleThinking(index)}
                          sx={{
                            textTransform: 'none',
                            color: 'text.secondary',
                            fontSize: '0.75rem',
                            minWidth: 'auto',
                            px: 1,
                            py: 0.5,
                          }}
                        >
                          Thinking
                        </Button>
                        {expandedThinking.has(index) && (
                          <Box
                            component={motion.div}
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.2 }}
                            sx={{
                              mt: 1,
                              p: 1.5,
                              backgroundColor: 'rgba(0, 0, 0, 0.02)',
                              borderRadius: 1,
                              fontSize: '0.875rem',
                              color: 'text.secondary',
                              fontFamily: 'monospace',
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              maxHeight: '400px',
                              overflow: 'auto',
                            }}
                          >
                            {message.thinking}
                          </Box>
                        )}
                      </Box>
                    )}
                    {/* Show typing indicator if streaming but no content yet */}
                    {isStreamingThisMessage && !displayContent && (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Typography variant="body2" color="text.secondary">
                          {label} is typing
                        </Typography>
                        <Box sx={{ display: 'flex', gap: 0.5 }}>
                          {[0, 1, 2].map((i) => (
                            <Box
                              key={i}
                              sx={{
                                width: 6,
                                height: 6,
                                borderRadius: '50%',
                                backgroundColor: 'primary.main',
                                animation: 'bounce 1.4s infinite ease-in-out',
                                animationDelay: `${i * 0.16}s`,
                                '@keyframes bounce': {
                                  '0%, 80%, 100%': {
                                    transform: 'scale(0)',
                                    opacity: 0.5,
                                  },
                                  '40%': {
                                    transform: 'scale(1)',
                                    opacity: 1,
                                  },
                                },
                              }}
                            />
                          ))}
                        </Box>
                      </Box>
                    )}
                    {/* Show images if present */}
                    {message.images && message.images.length > 0 && (
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: displayContent ? 1 : 0 }}>
                        {message.images.map((imageUuid, idx) => (
                          <Box
                            key={idx}
                            component="img"
                            src={apiClient.getImageUrl(imageUuid)}
                            alt={`Image ${idx + 1}`}
                            sx={{
                              maxWidth: '100%',
                              maxHeight: 300,
                              borderRadius: 1,
                              cursor: 'pointer',
                            }}
                            onClick={() => window.open(apiClient.getImageUrl(imageUuid), '_blank')}
                          />
                        ))}
                      </Box>
                    )}
                    {/* Show content with typing effect */}
                    {displayContent && (
                      <>
                        <ReactMarkdown
                          components={{
                            img: ({ node, ...props }) => (
                              <Box
                                component="img"
                                {...props}
                                sx={{
                                  maxWidth: '100%',
                                  maxHeight: 400,
                                  borderRadius: 1,
                                  cursor: 'pointer',
                                  my: 1,
                                }}
                                onClick={() => window.open(props.src, '_blank')}
                              />
                            ),
                          }}
                        >
                          {displayContent}
                        </ReactMarkdown>
                        {isStreamingThisMessage && (
                          <Box
                            component="span"
                            sx={{
                              display: 'inline-block',
                              width: '8px',
                              height: '16px',
                              backgroundColor: 'primary.main',
                              marginLeft: '2px',
                              animation: 'blink 1s infinite',
                              '@keyframes blink': {
                                '0%, 49%': { opacity: 1 },
                                '50%, 100%': { opacity: 0 },
                              },
                            }}
                          />
                        )}
                      </>
                    )}
                    {showFinishedIndicator && (
                      <Box
                        component={motion.div}
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.3 }}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 0.5,
                          mt: 1,
                          pt: 1,
                          borderTop: '1px solid',
                          borderColor: 'divider',
                          color: 'success.main',
                        }}
                      >
                        <CheckCircleIcon sx={{ fontSize: 16 }} />
                        <Typography variant="caption" color="success.main">
                          Done
                        </Typography>
                      </Box>
                    )}
                  </Box>
                </Paper>
              </MotionBox>
            );
          })}
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
