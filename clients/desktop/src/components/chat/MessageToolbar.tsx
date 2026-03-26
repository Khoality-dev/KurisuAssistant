import React from 'react';
import { Box, Chip, IconButton, Tooltip } from '@mui/material';
import {
  CheckCircle as CheckCircleIcon,
  VolumeUp as VolumeUpIcon,
  Stop as StopIcon,
  DataObject as DataObjectIcon,
  Refresh as RefreshIcon,
  ContentCopy as ContentCopyIcon,
  Delete as DeleteIcon,
} from '@mui/icons-material';

interface MessageToolbarProps {
  isUser: boolean;
  hasMessageId: boolean;
  hasRawData: boolean;
  copied: boolean;
  localPlaying: boolean;
  agentRole?: string;
  modelName?: string;
  onCopy: () => void;
  onTTS: () => void;
  onShowRaw: () => void;
  onResend: (() => void) | undefined;
  onRegenerate: (() => void) | undefined;
  onDelete: (() => void) | undefined;
}

export const MessageToolbar: React.FC<MessageToolbarProps> = ({
  isUser,
  hasMessageId,
  hasRawData,
  copied,
  localPlaying,
  agentRole,
  modelName,
  onCopy,
  onTTS,
  onShowRaw,
  onResend,
  onRegenerate,
  onDelete,
}) => {
  return (
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
      {/* Agent role chip */}
      {!isUser && agentRole && (
        <Chip label={agentRole} size="small" variant="outlined" sx={{ height: 20, fontSize: '0.65rem' }} />
      )}
      {/* Model name chip */}
      {!isUser && modelName && (
        <Chip label={modelName} size="small" variant="outlined" color="info" sx={{ height: 20, fontSize: '0.65rem' }} />
      )}
      {/* Copy */}
      <Tooltip title={copied ? 'Copied!' : 'Copy'}>
        <IconButton
          size="small"
          onClick={onCopy}
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
            onClick={onTTS}
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
      {!isUser && hasRawData && (
        <Tooltip title="Show raw LLM data">
          <IconButton
            size="small"
            onClick={onShowRaw}
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
            onClick={onResend}
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
            onClick={onRegenerate}
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
      {hasMessageId && onDelete && (
        <Tooltip title="Delete from here">
          <IconButton
            size="small"
            onClick={onDelete}
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
  );
};
