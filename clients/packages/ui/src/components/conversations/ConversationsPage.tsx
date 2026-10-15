import React, { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Typography,
  List,
  ListItem,
  ListItemButton,
  TextField,
  InputAdornment,
} from '@mui/material';
import { Search as SearchIcon, Add as AddIcon } from '@mui/icons-material';
import { useConversationStore } from '@kurisu/state';
import { apiClient } from '@kurisu/api';
import type { Conversation } from '@kurisu/models';

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

/**
 * The account's conversations, newest first (#178, #354). A conversation is not
 * tied to a persona — one persona, or none, answers in every conversation — so
 * a row is a conversation: its title, when it last moved and how it ended.
 * Opening one loads it in the chat panel beside this page.
 */
export const ConversationsPage: React.FC = () => {
  const currentId = useConversationStore((s) => s.currentConversation?.id ?? null);
  const messageCount = useConversationStore((s) => s.messages.length);
  const loadConversation = useConversationStore((s) => s.loadConversation);
  const clearCurrentConversation = useConversationStore((s) => s.clearCurrentConversation);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState('');

  // Read again whenever the open conversation changes or grows, so a reply
  // moves its row to the top and a new chat's first message adds one.
  useEffect(() => {
    let cancelled = false;
    apiClient.getConversations()
      .then((list) => { if (!cancelled) setConversations(list); })
      .catch((err) => console.error('Failed to load conversations:', err))
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [currentId, messageCount]);

  const query = search.trim().toLowerCase();
  const rows = query
    ? conversations.filter((c) =>
      (c.title || '').toLowerCase().includes(query)
      || (c.last_message?.content || '').toLowerCase().includes(query))
    : conversations;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <Box sx={{ px: 3, pt: 3, pb: 2, flexShrink: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2, gap: 2 }}>
          <Typography variant="h3">Conversations</Typography>
          <Button variant="outlined" size="small" startIcon={<AddIcon />} onClick={clearCurrentConversation}>
            New chat
          </Button>
        </Box>
        <TextField
          size="small"
          fullWidth
          placeholder="Search conversations..."
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

      <List sx={{ flex: 1, overflow: 'auto', px: 1.5, py: 0 }}>
        {loaded && rows.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 1 }}>
            {query ? 'No conversation matches.' : 'No conversations yet.'}
          </Typography>
        )}
        {rows.map((conversation) => {
          const isSelected = conversation.id === currentId;
          const timestamp = conversation.last_message?.created_at ?? conversation.updated_at;
          const preview = conversation.last_message?.content;

          return (
            <ListItem key={conversation.id} disablePadding sx={{ mb: 0.5 }}>
              <ListItemButton
                selected={isSelected}
                onClick={() => { if (!isSelected) void loadConversation(conversation.id); }}
                sx={{ py: 1.5, px: 2, borderRadius: 1, transition: 'all 150ms ease' }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 0.25 }}>
                    <Typography
                      variant="body2"
                      sx={{ fontWeight: isSelected ? 700 : 500, fontSize: '0.875rem' }}
                      noWrap
                    >
                      {conversation.title || 'New conversation'}
                    </Typography>
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
                  </Box>
                  <Typography
                    variant="body2"
                    sx={{ color: 'text.secondary', fontSize: '0.8rem' }}
                    noWrap
                  >
                    {preview || 'No messages yet'}
                  </Typography>
                </Box>
              </ListItemButton>
            </ListItem>
          );
        })}
      </List>
    </Box>
  );
};
