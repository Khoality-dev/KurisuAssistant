import React from 'react';
import {
  Drawer,
  Box,
  Typography,
  IconButton,
  List,
  ListItemButton,
  ListItemAvatar,
  Avatar,
} from '@mui/material';
import { Close as CloseIcon, SmartToy as AgentIcon } from '@mui/icons-material';
import { useSidebarStore } from '../store/sidebarStore';
import { useAgentStore } from '../store/agentStore';
import { apiClient } from '../api/client';

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

interface AgentSidebarProps {
  onSelectAgent: (id: number) => void;
}

export const AgentSidebar: React.FC<AgentSidebarProps> = ({ onSelectAgent }) => {
  const { isOpen, close } = useSidebarStore();
  const { agents, selectedAgentId, agentPreviews } = useAgentStore();

  const handleSelect = (id: number) => {
    onSelectAgent(id);
    close();
  };

  return (
    <Drawer
      anchor="left"
      open={isOpen}
      onClose={close}
      PaperProps={{
        sx: {
          width: 340,
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: '#F8FAFC',
          borderRight: 'none',
        },
      }}
    >
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 2.5,
          py: 2,
          backgroundColor: '#FFFFFF',
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Typography variant="h6" sx={{ fontWeight: 700, fontSize: '1.1rem', color: 'text.primary' }}>
          Conversations
        </Typography>
        <IconButton
          onClick={close}
          size="small"
          sx={{
            color: 'text.secondary',
            '&:hover': { backgroundColor: '#F1F5F9' },
          }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      {/* Agent list */}
      <List sx={{ flex: 1, overflow: 'auto', px: 1, py: 1 }}>
        {agents.map((agent) => {
          const preview = agentPreviews[agent.id];
          const hasMessage = !!preview?.lastMessage;
          const timestamp = preview?.lastMessage?.created_at;
          const messageText = preview?.lastMessage?.content;
          const isSelected = agent.id === selectedAgentId;

          return (
            <ListItemButton
              key={agent.id}
              selected={isSelected}
              onClick={() => handleSelect(agent.id)}
              sx={{
                py: 1.25,
                px: 1.5,
                borderRadius: '10px',
                mb: 0.5,
                border: '1px solid transparent',
                transition: 'all 0.15s ease',
                '&:hover': {
                  backgroundColor: '#FFFFFF',
                  border: '1px solid',
                  borderColor: 'divider',
                },
                '&.Mui-selected': {
                  backgroundColor: '#FFFFFF',
                  border: '1px solid',
                  borderColor: '#DBEAFE',
                  borderLeft: '3px solid #2563EB',
                  boxShadow: '0 1px 3px rgba(37, 99, 235, 0.08)',
                  '&:hover': {
                    backgroundColor: '#FAFCFF',
                  },
                },
              }}
            >
              <ListItemAvatar sx={{ minWidth: 0, mr: 1.5 }}>
                <Avatar
                  src={agent.avatar_uuid ? apiClient.getImageUrl(agent.avatar_uuid) : undefined}
                  sx={{
                    width: 44,
                    height: 44,
                    border: isSelected ? '2px solid #2563EB' : '2px solid #E2E8F0',
                    transition: 'border-color 0.15s ease',
                  }}
                >
                  {!agent.avatar_uuid && (
                    <AgentIcon sx={{ fontSize: 22, color: '#94A3B8' }} />
                  )}
                </Avatar>
              </ListItemAvatar>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 0.25 }}>
                  <Typography
                    variant="body2"
                    sx={{
                      fontWeight: isSelected ? 700 : 600,
                      color: 'text.primary',
                      fontSize: '0.875rem',
                      lineHeight: 1.3,
                    }}
                    noWrap
                  >
                    {agent.name}
                  </Typography>
                  {hasMessage && (
                    <Typography
                      variant="caption"
                      sx={{
                        color: isSelected ? 'primary.main' : 'text.secondary',
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
                  sx={{
                    color: 'text.secondary',
                    fontSize: '0.8rem',
                    lineHeight: 1.4,
                  }}
                  noWrap
                >
                  {hasMessage ? messageText : 'No messages yet'}
                </Typography>
              </Box>
            </ListItemButton>
          );
        })}
      </List>
    </Drawer>
  );
};
