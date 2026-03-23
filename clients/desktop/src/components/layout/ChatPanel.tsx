import React from 'react';
import { Box, Typography, IconButton, Avatar, Tooltip, Chip } from '@mui/material';
import {
  Refresh as RefreshIcon,
  Delete as DeleteIcon,
  Code as CodeIcon,
} from '@mui/icons-material';
import { useAgentStore } from '../../store/agentStore';
import { useConversationStore } from '../../store/conversationStore';
import { useExplorerStore } from '../../store/explorerStore';
import { ChatWidget } from '../ChatWidget';
import { MediaPlayerBar } from '../MediaPlayerBar';
import { apiClient } from '../../api/client';

export const ChatPanel: React.FC = () => {
  const { agents, selectedAgentId } = useAgentStore();
  const { currentConversation, deleteConversation } = useConversationStore();
  const selections = useExplorerStore((s) => s.selections);
  const setFileSelection = useExplorerStore((s) => s.setFileSelection);
  const selectionEntries = Object.values(selections);

  const selectedAgent = agents.find(a => a.id === selectedAgentId);

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
        {selectedAgent && (
          <>
            <Avatar
              src={selectedAgent.avatar_uuid ? apiClient.getImageUrl(selectedAgent.avatar_uuid) : undefined}
              sx={{ width: 28, height: 28, fontSize: '0.75rem' }}
            >
              {selectedAgent.name.charAt(0)}
            </Avatar>
            <Typography variant="body1" sx={{ fontWeight: 600, flex: 1 }}>
              {selectedAgent.name}
            </Typography>
          </>
        )}
        {!selectedAgent && (
          <Typography variant="body2" sx={{ color: 'text.secondary', flex: 1 }}>
            No agent selected
          </Typography>
        )}

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

      {/* Selection context chips */}
      {selectionEntries.length > 0 && (
        <Box
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 0.5,
            px: 1.5,
            py: 0.75,
            borderBottom: 1,
            borderColor: 'divider',
            flexShrink: 0,
          }}
        >
          {selectionEntries.map((sel) => (
            <Tooltip
              key={sel.filePath}
              title={`${sel.filePath}:${sel.startLine}-${sel.endLine}\n${sel.text.slice(0, 200)}${sel.text.length > 200 ? '...' : ''}`}
              placement="top"
            >
              <Chip
                icon={<CodeIcon sx={{ fontSize: 14 }} />}
                label={`${sel.fileName}:${sel.startLine}${sel.startLine !== sel.endLine ? `-${sel.endLine}` : ''}`}
                size="small"
                onDelete={() => setFileSelection(sel.filePath, null)}
                sx={{
                  fontSize: '0.7rem',
                  height: 24,
                  '& .MuiChip-icon': { ml: 0.5 },
                  '& .MuiChip-deleteIcon': { fontSize: 14 },
                }}
              />
            </Tooltip>
          ))}
        </Box>
      )}

      {/* Chat */}
      <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
        <ChatWidget />
      </Box>

      {/* Media player */}
      <MediaPlayerBar />
    </Box>
  );
};
