import React, { useState } from 'react';
import { Box, Paper, Typography, Button, IconButton, Tooltip, Avatar, Dialog, DialogTitle, DialogContent, DialogActions, CircularProgress } from '@mui/material';
import {
  CheckCircle as CheckCircleIcon,
  Psychology as PsychologyIcon,
  ExpandMore as ExpandMoreIcon,
  VolumeUp as VolumeUpIcon,
  Stop as StopIcon,
  SmartToy as SmartToyIcon,
  DataObject as DataObjectIcon,
  Refresh as RefreshIcon,
  ContentCopy as ContentCopyIcon,
  Delete as DeleteIcon,
} from '@mui/icons-material';
import { motion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import { apiClient } from '../api/client';
import { config } from '../config';
import { storage } from '../utils/storage';
import type { Message, MessageRawData } from '../api/types';

const MotionBox = motion(Box);

interface MessageBubbleProps {
  message: Message;
  index: number;
  isLast: boolean;
  isStreaming: boolean;
  streamingThinking: string;
  streamingContent: string;
  displayedThinking: string;
  displayedContent: string;
  justFinishedStreaming: boolean;
  expandedThinking: Set<number>;
  onToggleThinking: (index: number) => void;
  onRegenerate?: (messageIndex: number) => void;
  onResend?: (messageIndex: number) => void;
  onDelete?: (messageIndex: number) => void;
  ttsRef: React.RefObject<{ speak: (text: string, voice?: string, language?: string, backend?: string, emotionParams?: { emo_audio?: string; emo_alpha?: number; use_emo_text?: boolean }) => Promise<void>; stopTTS: () => void; isTTSPlaying: boolean; setActiveAgentForTTS: (agentId: number | null) => void }>;
}

const MessageBubbleComponent: React.FC<MessageBubbleProps> = ({
  message,
  index,
  isLast,
  isStreaming,
  streamingThinking,
  streamingContent,
  displayedThinking,
  displayedContent,
  justFinishedStreaming,
  expandedThinking,
  onToggleThinking,
  onRegenerate,
  onResend,
  onDelete,
  ttsRef,
}) => {
  const isStreamingThisMessage = isLast && message.role !== 'user' && isStreaming;
  const showFinishedIndicator = isLast && message.role !== 'user' && justFinishedStreaming && !isStreaming;
  const [localPlaying, setLocalPlaying] = useState(false);

  // Raw data dialog state
  const [rawDialogOpen, setRawDialogOpen] = useState(false);
  const [rawData, setRawData] = useState<MessageRawData | null>(null);
  const [rawLoading, setRawLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleShowRaw = async () => {
    if (!message.id) return;
    setRawDialogOpen(true);
    if (!rawData) {
      setRawLoading(true);
      try {
        const data = await apiClient.getMessageRaw(message.id);
        setRawData(data);
      } catch (error) {
        console.error('Failed to fetch raw data:', error);
      } finally {
        setRawLoading(false);
      }
    }
  };

  const handleTTS = async () => {
    if (localPlaying) {
      ttsRef.current.stopTTS();
      ttsRef.current.setActiveAgentForTTS(null);
      setLocalPlaying(false);
    } else {
      try {
        setLocalPlaying(true);
        // Activate this agent's character panel for lip sync
        if (message.agent?.id) {
          ttsRef.current.setActiveAgentForTTS(message.agent.id);
        }
        const currentBackend = storage.getTTSBackend() || 'vixtts';
        const emotionParams =
          currentBackend === 'vixtts'
            ? {
                emo_alpha: storage.getTTSEmotionAlpha(),
                use_emo_text: storage.getTTSUseEmotionText(),
              }
            : undefined;

        const voice = message.voice_reference || message.agent?.voice_reference || undefined;
        await ttsRef.current.speak(message.content, voice, undefined, currentBackend, emotionParams);
      } catch (error) {
        console.error('Failed to play TTS:', error);
      } finally {
        setLocalPlaying(false);
        ttsRef.current.setActiveAgentForTTS(null);
      }
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  // During streaming, display from typing effect, NOT from database
  const displayContent = isStreamingThisMessage ? displayedContent : message.content;
  const displayThinking = isStreamingThisMessage ? displayedThinking : message.thinking;

  // Determine message styling based on role
  const isUser = message.role === 'user';

  // Resolve display name: name field → agent relationship → role
  // For tool messages, skip agent?.name (it would show the calling agent, e.g. "Administrator")
  const agentName = message.role === 'tool'
    ? message.name
    : (message.name || message.agent?.name);
  const label = isUser
    ? 'You'
    : agentName || message.role.charAt(0).toUpperCase() + message.role.slice(1);

  // Get avatar URL for agent
  const agentAvatarUrl = message.agent?.avatar_uuid
    ? `${config.apiBaseUrl}/images/${message.agent.avatar_uuid}`
    : undefined;

  // Color scheme for different roles
  const getColorScheme = () => {
    if (isUser) {
      return {
        bg: '#FFFFFF',
        border: '#E5E5E5',
        label: 'text.primary'
      };
    }
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
          bg: '#EFF6FF',
          border: '#2563EB33',
          label: 'primary.main'
        };
    }
  };

  const colorScheme = getColorScheme();

  // Don't show hover toolbar while streaming
  const showToolbar = !isStreamingThisMessage && message.content;

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
        alignItems: 'flex-start',
        gap: 1.5,
        // Hover group: show toolbar on hover
        '&:hover .message-toolbar': {
          opacity: 1,
        },
      }}
    >
      {/* Agent avatar for non-user messages */}
      {!isUser && (
        <Avatar
          src={agentAvatarUrl}
          alt={label}
          sx={{
            width: 36,
            height: 36,
            bgcolor: 'primary.main',
            flexShrink: 0,
          }}
        >
          {!agentAvatarUrl && <SmartToyIcon sx={{ fontSize: 20 }} />}
        </Avatar>
      )}
      <Box sx={{ maxWidth: '80%' }}>
        <Paper
          elevation={0}
          sx={{
            p: 2,
            backgroundColor: colorScheme.bg,
            border: '1px solid',
            borderColor: colorScheme.border,
          }}
        >
          {/* Header: just the label */}
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
            {(message.thinking || (isStreamingThisMessage && streamingThinking)) && (
              <Box sx={{ mb: displayContent || message.images ? 1 : 0, pb: displayContent || message.images ? 1 : 0, borderBottom: displayContent || message.images ? '1px solid' : 'none', borderColor: 'divider' }}>
                <Button
                  size="small"
                  startIcon={<PsychologyIcon />}
                  endIcon={
                    <ExpandMoreIcon
                      sx={{
                        transform: (expandedThinking.has(index) || isStreamingThisMessage) ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 0.2s',
                      }}
                    />
                  }
                  onClick={() => onToggleThinking(index)}
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
                {(expandedThinking.has(index) || isStreamingThisMessage) && (
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
                    {displayThinking}
                    {isStreamingThisMessage && displayThinking && displayThinking.length < streamingThinking.length && (
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
                  </Box>
                )}
              </Box>
            )}
            {/* Show typing indicator if streaming but no thinking or content yet */}
            {isStreamingThisMessage && !displayThinking && !displayContent && (
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
            )}
            {/* Show images if present */}
            {message.images && message.images.length > 0 && (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: displayContent ? 1 : 0 }}>
                {message.images.map((imageUuid, idx) => (
                  <Box
                    key={idx}
                    component="img"
                    src={apiClient.getUserImageUrl(imageUuid)}
                    alt={`Image ${idx + 1}`}
                    sx={{
                      maxWidth: '100%',
                      maxHeight: 300,
                      borderRadius: 1,
                      cursor: 'pointer',
                    }}
                    onClick={() => window.open(apiClient.getUserImageUrl(imageUuid), '_blank')}
                  />
                ))}
              </Box>
            )}
            {/* Show content with typing effect */}
            {displayContent && (
              <>
                <ReactMarkdown
                  components={{
                    a: ({ node, children, href, ...props }) => (
                      <a
                        {...props}
                        href={href}
                        onClick={(e) => {
                          e.preventDefault();
                          if (href) (window as any).electron?.openExternal(href);
                        }}
                        style={{ cursor: 'pointer' }}
                      >
                        {children}
                      </a>
                    ),
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
                {isStreamingThisMessage &&
                 displayedThinking.length >= streamingThinking.length &&
                 displayedContent.length < streamingContent.length && (
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

        {/* Hover toolbar - appears below the bubble */}
        {showToolbar && (
          <Box
            className="message-toolbar"
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              mt: 0.5,
              opacity: 0,
              transition: 'opacity 0.15s ease-in-out',
              justifyContent: isUser ? 'flex-end' : 'flex-start',
            }}
          >
            {/* Copy */}
            <Tooltip title={copied ? 'Copied!' : 'Copy'}>
              <IconButton
                size="small"
                onClick={handleCopy}
                sx={{
                  p: 0.5,
                  color: copied ? 'success.main' : 'text.disabled',
                  '&:hover': { color: 'text.secondary', backgroundColor: 'action.hover' },
                }}
              >
                {copied ? <CheckCircleIcon sx={{ fontSize: 16 }} /> : <ContentCopyIcon sx={{ fontSize: 16 }} />}
              </IconButton>
            </Tooltip>
            {/* TTS - non-user messages only */}
            {!isUser && (
              <Tooltip title={localPlaying ? 'Stop' : 'Read aloud'}>
                <IconButton
                  size="small"
                  onClick={handleTTS}
                  sx={{
                    p: 0.5,
                    color: localPlaying ? 'error.main' : 'text.disabled',
                    '&:hover': { color: localPlaying ? 'error.main' : 'text.secondary', backgroundColor: 'action.hover' },
                  }}
                >
                  {localPlaying ? <StopIcon sx={{ fontSize: 16 }} /> : <VolumeUpIcon sx={{ fontSize: 16 }} />}
                </IconButton>
              </Tooltip>
            )}
            {/* Show raw data */}
            {!isUser && message.id && (
              <Tooltip title="Show raw LLM data">
                <IconButton
                  size="small"
                  onClick={handleShowRaw}
                  sx={{
                    p: 0.5,
                    color: 'text.disabled',
                    '&:hover': { color: 'text.secondary', backgroundColor: 'action.hover' },
                  }}
                >
                  <DataObjectIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            )}
            {/* Resend - user messages only */}
            {isUser && onResend && (
              <Tooltip title="Resend">
                <IconButton
                  size="small"
                  onClick={() => onResend(index)}
                  sx={{
                    p: 0.5,
                    color: 'text.disabled',
                    '&:hover': { color: 'text.secondary', backgroundColor: 'action.hover' },
                  }}
                >
                  <RefreshIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            )}
            {/* Regenerate - non-user messages only */}
            {!isUser && onRegenerate && (
              <Tooltip title="Regenerate">
                <IconButton
                  size="small"
                  onClick={() => onRegenerate(index)}
                  sx={{
                    p: 0.5,
                    color: 'text.disabled',
                    '&:hover': { color: 'text.secondary', backgroundColor: 'action.hover' },
                  }}
                >
                  <RefreshIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            )}
            {/* Delete */}
            {message.id && onDelete && (
              <Tooltip title="Delete from here">
                <IconButton
                  size="small"
                  onClick={() => onDelete(index)}
                  sx={{
                    p: 0.5,
                    color: 'text.disabled',
                    '&:hover': { color: 'error.main', backgroundColor: 'action.hover' },
                  }}
                >
                  <DeleteIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            )}
          </Box>
        )}
      </Box>

      {/* Raw Data Dialog */}
      <Dialog
        open={rawDialogOpen}
        onClose={() => setRawDialogOpen(false)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <DataObjectIcon />
          Raw LLM Data
        </DialogTitle>
        <DialogContent dividers>
          {rawLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress />
            </Box>
          ) : rawData ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Box>
                <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
                  Raw Input (messages sent to LLM)
                </Typography>
                <Box
                  sx={{
                    backgroundColor: '#F3F4F6',
                    p: 2,
                    borderRadius: 1,
                    overflow: 'auto',
                    maxHeight: 400,
                    fontFamily: 'Consolas, Monaco, monospace',
                    fontSize: '0.8rem',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {rawData.raw_input
                    ? JSON.stringify(rawData.raw_input, null, 2)
                    : 'No raw input data available'}
                </Box>
              </Box>
              <Box>
                <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
                  Raw Output (full LLM response)
                </Typography>
                <Box
                  sx={{
                    backgroundColor: '#F3F4F6',
                    p: 2,
                    borderRadius: 1,
                    overflow: 'auto',
                    maxHeight: 400,
                    fontFamily: 'Consolas, Monaco, monospace',
                    fontSize: '0.8rem',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {rawData.raw_output || 'No raw output data available'}
                </Box>
              </Box>
            </Box>
          ) : (
            <Typography color="text.secondary">Failed to load raw data.</Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRawDialogOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </MotionBox>
  );
};

function areMessageBubblePropsEqual(prev: MessageBubbleProps, next: MessageBubbleProps): boolean {
  return (
    prev.message === next.message &&
    prev.index === next.index &&
    prev.isLast === next.isLast &&
    prev.isStreaming === next.isStreaming &&
    prev.streamingThinking === next.streamingThinking &&
    prev.streamingContent === next.streamingContent &&
    prev.displayedThinking === next.displayedThinking &&
    prev.displayedContent === next.displayedContent &&
    prev.justFinishedStreaming === next.justFinishedStreaming &&
    prev.expandedThinking.has(prev.index) === next.expandedThinking.has(next.index) &&
    prev.onToggleThinking === next.onToggleThinking &&
    prev.onRegenerate === next.onRegenerate &&
    prev.onResend === next.onResend &&
    prev.onDelete === next.onDelete &&
    prev.ttsRef === next.ttsRef
  );
}

export const MessageBubble = React.memo(MessageBubbleComponent, areMessageBubblePropsEqual);
