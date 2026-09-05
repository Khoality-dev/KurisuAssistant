import React, { useState, useEffect, useRef } from 'react';
import { Box, Paper, Typography, Button, Avatar, Chip } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import {
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

import type { StreamingMessage } from '../../hooks/useStreamingChat';
import { MessageToolbar } from './MessageToolbar';
import { RawDataDialog } from './RawDataDialog';
import { useExplorerStore } from '../../store/explorerStore';
import { useLayoutStore } from '../../store/layoutStore';
import { usePersonaStore } from '../../store/personaStore';

const MotionBox = motion(Box);

/** Wraps children and highlights text nodes matching `query` via DOM manipulation. */
const HighlightWrapper: React.FC<{ query?: string; children: React.ReactNode }> = ({ query, children }) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Remove previous highlights
    el.querySelectorAll('mark[data-search-hl]').forEach((mark) => {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
        parent.normalize();
      }
    });
    if (!query) return;
    const q = query.toLowerCase();
    // Walk text nodes and wrap matches
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const node of nodes) {
      const text = node.textContent || '';
      const lower = text.toLowerCase();
      const idx = lower.indexOf(q);
      if (idx === -1) continue;
      const before = text.slice(0, idx);
      const match = text.slice(idx, idx + q.length);
      const after = text.slice(idx + q.length);
      const mark = document.createElement('mark');
      mark.setAttribute('data-search-hl', '');
      mark.style.backgroundColor = '#FFD54F';
      mark.style.color = '#000';
      mark.style.borderRadius = '2px';
      mark.style.padding = '0 2px';
      mark.textContent = match;
      const parent = node.parentNode!;
      if (before) parent.insertBefore(document.createTextNode(before), node);
      parent.insertBefore(mark, node);
      if (after) parent.insertBefore(document.createTextNode(after), node);
      parent.removeChild(node);
    }
  }, [query, children]);

  return <div ref={ref}>{children}</div>;
};

interface MessageBubbleProps {
  // StreamingMessage, not Message: `tool_kind` and `duration_ms` reach the bubble
  // on live tool chunks only and are absent from anything reloaded from the DB.
  message: StreamingMessage;
  index: number;
  consecutive?: boolean;
  isLast: boolean;
  isStreaming: boolean;
  streamingThinking: string;
  streamingContent: string;
  displayedThinking: string;
  displayedContent: string;
  justFinishedStreaming: boolean;
  expandedThinking: Set<number>;
  onToggleThinking: (index: number) => void;
  searchHighlight?: string;
  ttsRef: React.RefObject<{ speak: (text: string, voice?: string, language?: string, backend?: string, emotionParams?: { emo_audio?: string; emo_alpha?: number; use_emo_text?: boolean }) => Promise<void>; stopTTS: () => void; clearQueue: () => void; isTTSPlaying: boolean; setActivePersonaForTTS: (personaId: number | null) => void }>;
  isQueueActive?: boolean;
}

const MessageBubbleComponent: React.FC<MessageBubbleProps> = ({
  message,
  index,
  consecutive,
  isLast,
  isStreaming,
  streamingThinking,
  streamingContent,
  displayedThinking,
  displayedContent,
  justFinishedStreaming,
  expandedThinking,
  onToggleThinking,
  searchHighlight,
  ttsRef,
  isQueueActive,
}) => {
  const isStreamingThisMessage = isLast && message.role !== 'user' && isStreaming;
  // Suppress unused var warning — the "Done" indicator was removed because mounting
  // it on stream completion (and unmounting 3s later) shifted layout and caused a
  // visible scroll jump on every finished message.
  void justFinishedStreaming;
  const [localPlaying, setLocalPlaying] = useState(false);
  // Show TTS active on the last assistant bubble during auto-play
  const autoPlaying = !!(isQueueActive && isLast && message.role !== 'user' && !localPlaying);

  // Raw data dialog state
  const [rawDialogOpen, setRawDialogOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleShowRaw = () => {
    if (!message.id) return;
    setRawDialogOpen(true);
  };

  const handleTTS = async () => {
    if (localPlaying || autoPlaying) {
      // Stop both manual playback and streaming auto-play queue
      ttsRef.current?.stopTTS();
      ttsRef.current?.clearQueue();
      ttsRef.current?.setActivePersonaForTTS(null);
      setLocalPlaying(false);
    } else {
      try {
        setLocalPlaying(true);
        // Activate this persona's character panel for lip sync
        if (message.persona?.id) {
          ttsRef.current?.setActivePersonaForTTS(message.persona.id);
        }
        const currentBackend = storage.getTTSBackend() || 'vixtts';
        const emotionParams =
          currentBackend === 'vixtts'
            ? {
                emo_alpha: storage.getTTSEmotionAlpha(),
                use_emo_text: storage.getTTSUseEmotionText(),
              }
            : undefined;

        const voice = message.voice_reference || message.persona?.voice_reference || undefined;
        await ttsRef.current?.speak(message.content, voice, undefined, currentBackend, emotionParams);
      } catch (error) {
        console.error('Failed to play TTS:', error);
      } finally {
        setLocalPlaying(false);
        ttsRef.current?.setActivePersonaForTTS(null);
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
    // Assistant: the persona is the speaker. `persona_name` comes from streaming
    // chunks, `persona` is the stamp embedded on a stored message; neither exists
    // on a tool message, which is handled above. `name` is the last resort — on
    // an assistant message it is the persona name the backend stored.
    label = message.persona_name
      || message.persona?.name
      || message.name
      || message.role.charAt(0).toUpperCase() + message.role.slice(1);
  }

  // Avatar. Fall back to the persona store keyed by persona_id — streaming
  // chunks carry persona_id but no embedded `persona` (with avatar_uuid), so
  // without the fallback the avatar would be missing during streaming and then
  // pop in after the post-done reload, flashing the bubble. Select the uuid
  // string (not the persona object) so Zustand's Object.is equality keeps the
  // selector stable across unrelated persona-list updates.
  const storeAvatarUuid = usePersonaStore((s) =>
    message.persona_id != null
      ? s.personas.find((p) => p.id === message.persona_id)?.avatar_uuid ?? null
      : null,
  );
  const avatarUuid = message.persona?.avatar_uuid ?? storeAvatarUuid;
  const personaAvatarUrl = avatarUuid
    ? `${config.apiBaseUrl}/images/${avatarUuid}`
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
        const isError = message.tool_status === 'error' || message.tool_status === 'denied';
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

  // Always render the toolbar when there's content — it's hidden via opacity:0
  // and revealed on hover. Mounting it only after streaming finishes used to
  // grow the bubble's footprint and snap-scroll the view on every completion.
  const showToolbar = !!message.content;

  return (
    <MotionBox
      key={index}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: message.queued ? 0.5 : 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
      sx={{
        mb: consecutive ? 0.5 : 2,
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        alignItems: 'flex-start',
        gap: 1.5,
        ...(message.queued && { opacity: 0.5 }),
        // Hover group: show toolbar on hover
        '&:hover .message-toolbar': {
          opacity: 1,
        },
      }}
    >
      {/* Avatar for non-user messages */}
      {!isUser && (
        <Avatar
          src={isTool ? undefined : personaAvatarUrl}
          alt={label}
          sx={{
            width: 36,
            height: 36,
            bgcolor: isTool ? 'action.selected' : 'primary.main',
            flexShrink: 0,
          }}
        >
          {isTool ? <BuildIcon sx={{ fontSize: 20, color: 'text.secondary' }} /> : !personaAvatarUrl && <SmartToyIcon sx={{ fontSize: 20 }} />}
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
            {message.queued && (
              <Typography variant="caption" sx={{ color: 'text.disabled', fontStyle: 'italic', ml: 0.5 }}>
                Queued
              </Typography>
            )}
            {/* `tool_kind` and `duration_ms` ride on live tool chunks only — the
                client cannot derive either, and neither survives a reload. */}
            {isTool && message.tool_kind === 'sub_agent' && (
              <Chip label="sub-agent" size="small" sx={{ height: 18, fontSize: '0.65rem', ml: 0.5 }} />
            )}
            {isTool && message.duration_ms != null && (
              <Typography variant="caption" sx={{ color: 'text.secondary', ml: 0.5 }}>
                {message.duration_ms < 1000
                  ? `${message.duration_ms}ms`
                  : `${(message.duration_ms / 1000).toFixed(1)}s`}
              </Typography>
            )}
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
            {/* Show context files as clickable chips */}
            {message.context_files && message.context_files.length > 0 && (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 1 }}>
                {message.context_files.map((cf, idx) => {
                  const label = cf.startLine
                    ? `${cf.fileName}:${cf.startLine}-${cf.endLine}`
                    : cf.fileName;
                  return (
                    <Chip
                      key={idx}
                      label={label}
                      size="small"
                      variant="outlined"
                      onClick={() => {
                        const store = useExplorerStore.getState();
                        const fileIdx = store.openFiles.findIndex(f => f.path === cf.path);
                        if (fileIdx !== -1) {
                          store.setActiveFile(fileIdx);
                        } else {
                          const ext = cf.fileName.includes('.') ? '.' + cf.fileName.split('.').pop() : '';
                          store.openFile({ name: cf.fileName, fullPath: cf.path, type: 'file', size: 0, modified: null, extension: ext });
                        }
                        useLayoutStore.getState().setActivePage('workspace');
                      }}
                      sx={{
                        fontSize: '0.75rem',
                        height: 24,
                        cursor: 'pointer',
                        '&:hover': { bgcolor: 'action.hover' },
                      }}
                    />
                  );
                })}
              </Box>
            )}
            {/* Show content with typing effect */}
            {displayContent && (
              <>
                <HighlightWrapper query={searchHighlight}>
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
                    img: ({ node, ref: _ref, ...props }) => (
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
                </HighlightWrapper>
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
          </Box>}
        </Paper>

        {/* Hover toolbar - appears below the bubble */}
        {showToolbar && (
          <MessageToolbar
            isUser={isUser}
            hasRawData={!!message.id}
            copied={copied}
            localPlaying={localPlaying || autoPlaying}
            modelName={message.model_name || undefined}
            onCopy={handleCopy}
            onTTS={handleTTS}
            onShowRaw={handleShowRaw}
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
    prev.consecutive === next.consecutive &&
    prev.searchHighlight === next.searchHighlight &&
    prev.ttsRef === next.ttsRef
  );
}

export const MessageBubble = React.memo(MessageBubbleComponent, areMessageBubblePropsEqual);
