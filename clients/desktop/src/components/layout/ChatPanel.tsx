import React from 'react';
import { Box, Typography, IconButton, Tooltip } from '@mui/material';
import {
  Refresh as RefreshIcon,
  Delete as DeleteIcon,
} from '@mui/icons-material';
import { useConversationStore } from '../../store/conversationStore';
import { ChatWidget } from '../chat/ChatWidget';
import { MediaPlayerBar } from '../MediaPlayerBar';

export const ChatPanel: React.FC = () => {
  const { currentConversation, deleteConversation } = useConversationStore();

  const handleRefresh = () => {
    if (currentConversation?.id) {
      useConversationStore.getState().loadConversation(currentConversation.id);
    }
  };

  const handleClear = async () => {
    if (currentConversation?.id) {
      await deleteConversation(currentConversation.id);
    }
  };

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        bgcolor: 'background.default',
        borderLeft: 1,
        borderColor: 'divider',
      }}
    >
      {/* Agent header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          px: 2,
          py: 1.5,
          borderBottom: 1,
          borderColor: 'divider',
          flexShrink: 0,
        }}
      >
        <Typography variant="body1" sx={{ fontWeight: 600, flex: 1 }}>
          Chat
        </Typography>

        <Tooltip title="Refresh">
          <IconButton size="small" onClick={handleRefresh} sx={{ color: 'text.secondary' }}>
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Clear conversation">
          <IconButton
            size="small"
            onClick={handleClear}
            sx={{ color: 'text.secondary', '&:hover': { color: 'error.main' } }}
          >
            <DeleteIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Chat */}
      <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex', minWidth: 0 }}>
        <ChatWidget />
      </Box>

      {/* Media player */}
      <MediaPlayerBar />
    </Box>
  );
};
