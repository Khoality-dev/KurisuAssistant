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
          backgroundColor: '#FFFFFF',
          borderRight: '1px solid',
          borderColor: '#E2E8F0',
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
          py: 1.75,
          backgroundColor: '#FFFFFF',
          borderBottom: '1px solid',
          borderColor: '#E2E8F0',
        }}
      >
        <Typography variant="overline" sx={{ fontWeight: 700, letterSpacing: '0.12em', color: '#475569' }}>
          Conversations
        </Typography>
        <IconButton
          onClick={close}
          size="small"
          sx={{
            color: '#475569',
            borderRadius: 0,
            '&:hover': { backgroundColor: '#F1F5F9' },
          }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      {/* Agent list */}
      <List sx={{ flex: 1, overflow: 'auto', px: 0, py: 0 }}>
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
                py: 1.4,
                px: 2,
                borderRadius: 0,
                mb: 0,
                borderBottom: '1px solid',
                borderColor: '#E2E8F0',
                transition: 'background-color 0.15s ease',
                '&:hover': {
                  backgroundColor: '#F8FAFC',
                },
                '&.Mui-selected': {
                  backgroundColor: '#F1F5F9',
                  borderLeft: '4px solid #2563EB',
                  pl: 'calc(16px - 4px)',
                  '&:hover': {
                    backgroundColor: '#EEF2F7',
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
                    borderRadius: 0,
                    backgroundColor: '#EFF6FF',
                    color: '#2563EB',
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
                      color: '#0F172A',
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
                        color: isSelected ? '#2563EB' : '#64748B',
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
                    color: '#64748B',
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
