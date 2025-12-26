import React from 'react';
import { Box, Paper, Typography, Button } from '@mui/material';
import {
  CheckCircle as CheckCircleIcon,
  Psychology as PsychologyIcon,
  ExpandMore as ExpandMoreIcon,
} from '@mui/icons-material';
import { motion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import { apiClient } from '../api/client';
import type { Message } from '../api/types';

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
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({
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
}) => {
  const isStreamingThisMessage = isLast && message.role !== 'user' && isStreaming;
  const showFinishedIndicator = isLast && message.role !== 'user' && justFinishedStreaming && !isStreaming;

  // During streaming, display from typing effect, NOT from database
  const displayContent = isStreamingThisMessage ? displayedContent : message.content;
  const displayThinking = isStreamingThisMessage ? displayedThinking : message.thinking;

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
          {(message.thinking || (isStreamingThisMessage && streamingThinking)) && (
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
                  {displayThinking}
                  {/* Show cursor while thinking is being typed */}
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
              {/* Show cursor when content is being typed (thinking is done, content still typing) */}
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
    </MotionBox>
  );
};
