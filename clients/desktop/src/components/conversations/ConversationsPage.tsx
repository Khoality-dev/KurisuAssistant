import React, { useEffect } from 'react';
import {
  Box,
  Typography,
  List,
  ListItemButton,
  ListItemAvatar,
  Avatar,
  TextField,
  InputAdornment,
} from '@mui/material';
import {
  SmartToy as AgentIcon,
  Search as SearchIcon,
} from '@mui/icons-material';
import { useAgentStore } from '../../store/agentStore';
import { apiClient } from '../../api/client';
import { storage } from '../../utils/storage';
import { useConversationStore } from '../../store/conversationStore';

function formatRelativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay}d`;
  return date.toLocaleDateString();
}

export const ConversationsPage: React.FC = () => {
  const { agents, selectedAgentId, selectAgent, agentPreviews, loadAgentPreviews } = useAgentStore();
  const { loadConversation } = useConversationStore();
  const [search, setSearch] = React.useState('');

  useEffect(() => {
    loadAgentPreviews();
  }, [loadAgentPreviews]);

  const handleSelectAgent = async (id: number) => {
    selectAgent(id);
    // Load conversation for this agent
    const conversationId = storage.getAgentConversationId(id);
    if (conversationId) {
      await loadConversation(conversationId);
    }
  };

  const filteredAgents = search
    ? agents.filter(a => a.name.toLowerCase().includes(search.toLowerCase()))
    : agents;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <Box sx={{ px: 3, pt: 3, pb: 2, flexShrink: 0 }}>
        <Typography variant="h3" sx={{ mb: 2 }}>Conversations</Typography>
        <TextField
          size="small"
          fullWidth
          placeholder="Search agents..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon sx={{ color: 'text.secondary', fontSize: 20 }} />
              </InputAdornment>
            ),
          }}
        />
      </Box>

      {/* Agent list */}
      <List sx={{ flex: 1, overflow: 'auto', px: 1.5, py: 0 }}>
        {filteredAgents.map((agent) => {
          const preview = agentPreviews[agent.id];
          const hasMessage = !!preview?.lastMessage;
          const timestamp = preview?.lastMessage?.created_at;
          const messageText = preview?.lastMessage?.content;
          const isSelected = agent.id === selectedAgentId;

          return (
            <ListItemButton
              key={agent.id}
              selected={isSelected}
              onClick={() => handleSelectAgent(agent.id)}
              sx={{
                py: 1.5,
                px: 2,
                borderRadius: 1,
                mb: 0.5,
                transition: 'all 150ms ease',
              }}
            >
              <ListItemAvatar sx={{ minWidth: 0, mr: 1.5 }}>
                <Avatar
                  src={agent.avatar_uuid ? apiClient.getImageUrl(agent.avatar_uuid) : undefined}
                  sx={{
                    width: 40,
                    height: 40,
                    bgcolor: (t) => t.palette.mode === 'light' ? '#F3F4F6' : '#262626',
                  }}
                >
                  {!agent.avatar_uuid && (
                    <AgentIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
                  )}
                </Avatar>
              </ListItemAvatar>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 0.25 }}>
                  <Typography
                    variant="body2"
                    sx={{ fontWeight: isSelected ? 700 : 500, fontSize: '0.875rem' }}
                    noWrap
                  >
                    {agent.name}
                  </Typography>
                  {hasMessage && (
                    <Typography
                      variant="caption"
                      sx={{
                        color: isSelected ? 'info.main' : 'text.secondary',
                        fontSize: '0.7rem',
                        fontWeight: isSelected ? 600 : 400,
                        ml: 1,
                        flexShrink: 0,
                      }}
                    >
                      {formatRelativeTime(timestamp)}
                    </Typography>
                  )}
                </Box>
                <Typography
                  variant="body2"
                  sx={{ color: 'text.secondary', fontSize: '0.8rem' }}
                  noWrap
                >
                  {hasMessage ? messageText : 'No messages yet'}
                </Typography>
              </Box>
            </ListItemButton>
          );
        })}
      </List>
    </Box>
  );
};
