import React, { useEffect } from 'react';
import {
  Box,
  Typography,
  List,
  ListItemButton,
  TextField,
  InputAdornment,
} from '@mui/material';
import { Search as SearchIcon } from '@mui/icons-material';
import { usePersonaStore } from '@kurisu/state';
import { storage } from '@kurisu/api';
import { useConversationStore } from '@kurisu/state';

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
  const { personas, selectedPersonaId, selectPersona, personaPreviews, loadPersonaPreviews } = usePersonaStore();
  const { loadConversation } = useConversationStore();
  const [search, setSearch] = React.useState('');

  useEffect(() => {
    loadPersonaPreviews();
  }, [loadPersonaPreviews]);

  const handleSelectPersona = async (id: number) => {
    selectPersona(id);
    // Load the conversation this persona is mapped to, if any.
    const conversationId = storage.getPersonaConversationId(id);
    if (conversationId) {
      await loadConversation(conversationId);
    }
  };

  // Every persona is listed: sub-agents are a separate resource and never speak.
  const filteredPersonas = search
    ? personas.filter(p => p.name.toLowerCase().includes(search.toLowerCase()))
    : personas;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <Box sx={{ px: 3, pt: 3, pb: 2, flexShrink: 0 }}>
        <Typography variant="h3" sx={{ mb: 2 }}>Conversations</Typography>
        <TextField
          size="small"
          fullWidth
          placeholder="Search personas..."
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

      {/* Persona list */}
      <List sx={{ flex: 1, overflow: 'auto', px: 1.5, py: 0 }}>
        {filteredPersonas.map((persona) => {
          const preview = personaPreviews[persona.id];
          const hasMessage = !!preview?.lastMessage;
          const timestamp = preview?.lastMessage?.created_at;
          const messageText = preview?.lastMessage?.content;
          const isSelected = persona.id === selectedPersonaId;

          return (
            <ListItemButton
              key={persona.id}
              selected={isSelected}
              onClick={() => handleSelectPersona(persona.id)}
              sx={{
                py: 1.5,
                px: 2,
                borderRadius: 1,
                mb: 0.5,
                transition: 'all 150ms ease',
              }}
            >
              {/*
                No avatar. One assistant answers every row through the same
                default persona, so the face was the same face repeated down the
                list — it distinguished nothing and took the width the name and
                the preview needed (#192).
              */}
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 0.25 }}>
                  <Typography
                    variant="body2"
                    sx={{ fontWeight: isSelected ? 700 : 500, fontSize: '0.875rem' }}
                    noWrap
                  >
                    {persona.name}
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
