import React, { useState } from 'react';
import { Box, Paper, Typography, Button, Avatar } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import {
  CheckCircle as CheckCircleIcon,
  Psychology as PsychologyIcon,
  ExpandMore as ExpandMoreIcon,
  SmartToy as SmartToyIcon,
  Build as BuildIcon,
} from '@mui/icons-material';
import { motion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import { apiClient } from '../../api/client';
import { config } from '../../config';
import { storage } from '../../utils/storage';
import type { Message } from '../../api/types';
import { MessageToolbar } from './MessageToolbar';
import { RawDataDialog } from './RawDataDialog';

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
  const [copied, setCopied] = useState(false);

  const handleShowRaw = () => {
    if (!message.id) return;
    setRawDialogOpen(true);
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

  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';

  // Determine message styling based on role
  const isUser = message.role === 'user';

  // Resolve display label
  let label: string;
  if (isUser) {
    label = 'You';
  } else if (message.role === 'tool') {
    if (message.name && message.tool_args) {
      const args = Object.entries(message.tool_args)
        .map(([k, v]) => {
          const str = typeof v === 'string' ? v : JSON.stringify(v);
          return `${k}: ${str.length > 50 ? str.substring(0, 50) + '...' : str}`;
        })
        .join(', ');
      label = `${message.name}(${args})`;
    } else {
      label = message.name || 'Tool';
    }
  } else {
    // Assistant: persona name as main label
    const personaName = message.persona_name || message.agent?.persona_name;
    const agentRole = message.agent?.name || message.name;
    label = personaName || agentRole || message.role.charAt(0).toUpperCase() + message.role.slice(1);
  }

  // Get avatar URL for agent
  const agentAvatarUrl = message.agent?.avatar_uuid
    ? `${config.apiBaseUrl}/images/${message.agent.avatar_uuid}`
    : undefined;

  // Color scheme for different roles
  const getColorScheme = () => {
    if (isUser) {
      return {
        bg: isDark ? '#1A1A1A' : '#FFFFFF',
        border: isDark ? '#333333' : '#E5E5E5',
        label: 'text.primary'
      };
    }
    switch (message.role) {
      case 'tool': {
        const lc = message.content.toLowerCase();
        const isError = message.content.startsWith('Error:') || lc.includes('error') || lc.includes('rejected') || lc.includes('denied') || lc.includes('not available') || lc.includes('not found') || lc.includes('failed');
        if (isError) {
          return {
            bg: isDark ? '#2A0000' : '#FFF0F0',
            border: isDark ? '#660000' : '#EF5350',
            label: isDark ? '#EF5350' : '#D32F2F'
          };
        }
        return {
          bg: isDark ? '#002A00' : '#F0FFF0',
          border: isDark ? '#006600' : '#66BB6A',
          label: isDark ? '#66BB6A' : '#2E7D32'
        };
      }
      case 'assistant':
      default:
        return {
          bg: isDark ? '#0D1B2A' : '#EFF6FF',
          border: isDark ? '#1E3A5F' : '#2563EB33',
          label: 'primary.main'
        };
    }
  };

  const colorScheme = getColorScheme();
  const isTool = message.role === 'tool';
  const [toolExpanded, setToolExpanded] = useState(false);

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
      {/* Avatar for non-user messages */}
      {!isUser && (
        <Avatar
          src={isTool ? undefined : agentAvatarUrl}
          alt={label}
          sx={{
            width: 36,
            height: 36,
            bgcolor: isTool ? 'action.selected' : 'primary.main',
            flexShrink: 0,
          }}
        >
          {isTool ? <BuildIcon sx={{ fontSize: 20, color: 'text.secondary' }} /> : !agentAvatarUrl && <SmartToyIcon sx={{ fontSize: 20 }} />}
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
            overflow: 'hidden',
            wordBreak: 'break-word',
          }}
        >
          {/* Header */}
          <Box
            onClick={isTool ? () => setToolExpanded(!toolExpanded) : undefined}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              mb: isTool && !toolExpanded ? 0 : 1,
              cursor: isTool ? 'pointer' : 'default',
              userSelect: isTool ? 'none' : 'auto',
            }}
          >
            <Typography
              variant="caption"
              sx={{
                fontWeight: 600,
                color: colorScheme.label,
              }}
            >
              {label}
            </Typography>
            <Box sx={{ flex: 1 }} />
            {isTool && (
              <ExpandMoreIcon
                sx={{
                  fontSize: 16,
                  color: 'text.secondary',
                  transform: toolExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 150ms ease',
                }}
              />
            )}
          </Box>
          {/* Content — collapsed by default for tool messages */}
          {(!isTool || toolExpanded) && <Box
            sx={{
              '& p': { margin: 0, marginBottom: 1 },
              '& p:last-child': { marginBottom: 0 },
              '& code': {
                backgroundColor: isDark ? '#1A1A1A' : '#F3F4F6',
                padding: '2px 6px',
                borderRadius: 1,
                fontFamily: 'Consolas, Monaco, monospace',
                fontSize: '0.875em',
              },
              '& pre': {
                backgroundColor: isDark ? '#1A1A1A' : '#F3F4F6',
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
                    pre: ({ children }) => (
                      <Box
                        component="pre"
                        sx={{
                          overflowX: 'auto',
                          maxWidth: '100%',
                          bgcolor: isDark ? '#0D0D0D' : '#F3F4F6',
                          borderRadius: 1,
                          p: 1.5,
                          my: 1,
                          fontSize: '0.8rem',
                          lineHeight: 1.5,
                          '& code': { background: 'none', p: 0, fontSize: 'inherit' },
                        }}
                      >
                        {children}
                      </Box>
                    ),
                    code: ({ children, className }) => {
                      const isInline = !className;
                      return isInline ? (
                        <Box
                          component="code"
                          sx={{
                            bgcolor: isDark ? '#1A1A1A' : '#F3F4F6',
                            px: 0.5,
                            py: 0.25,
                            borderRadius: 0.5,
                            fontSize: '0.85em',
                          }}
                        >
                          {children}
                        </Box>
                      ) : (
                        <code className={className}>{children}</code>
                      );
                    },
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
          </Box>}
        </Paper>

        {/* Hover toolbar - appears below the bubble */}
        {showToolbar && (
          <MessageToolbar
            isUser={isUser}
            hasMessageId={!!message.id}
            hasRawData={!!message.id}
            copied={copied}
            localPlaying={localPlaying}
            agentRole={message.role === 'assistant' ? (message.agent?.name || message.name) || undefined : undefined}
            modelName={message.model_name || undefined}
            onCopy={handleCopy}
            onTTS={handleTTS}
            onShowRaw={handleShowRaw}
            onResend={onResend ? () => onResend(index) : undefined}
            onRegenerate={onRegenerate ? () => onRegenerate(index) : undefined}
            onDelete={onDelete ? () => onDelete(index) : undefined}
          />
        )}
      </Box>

      {/* Raw Data Dialog */}
      <RawDataDialog
        open={rawDialogOpen}
        onClose={() => setRawDialogOpen(false)}
        messageId={message.id}
      />
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
