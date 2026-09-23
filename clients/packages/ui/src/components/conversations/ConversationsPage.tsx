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
import { ASSISTANT_NAME } from '@kurisu/models';
import type { PersonaPreview } from '@kurisu/state';

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

/** One row: the assistant itself (`id: null`) or a persona. */
interface Row {
  id: number | null;
  name: string;
  preview: PersonaPreview | null | undefined;
}

export const ConversationsPage: React.FC = () => {
  const { personas, selectedPersonaId, selectPersona, personaPreviews, assistantPreview, loadPersonaPreviews } = usePersonaStore();
  const { loadConversation } = useConversationStore();
  const [search, setSearch] = React.useState('');

  useEffect(() => {
    loadPersonaPreviews();
  }, [loadPersonaPreviews]);

  const handleSelect = async (id: number | null) => {
    selectPersona(id);
    // Load the conversation this row is mapped to, if any.
    const conversationId = storage.getPersonaConversationId(id ?? 'unbound');
    if (conversationId) {
      await loadConversation(conversationId);
    }
  };

  // The assistant itself heads the list — a persona is optional, and its own
  // conversations must stay reachable with none (#302) — then every persona.
  // Sub-agents are a separate resource and never speak.
  const rows: Row[] = [
    { id: null, name: ASSISTANT_NAME, preview: assistantPreview },
    ...personas.map((p) => ({ id: p.id, name: p.name, preview: personaPreviews[p.id] })),
  ];
  const filteredRows = search
    ? rows.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()))
    : rows;

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
        {filteredRows.map((row) => {
          const preview = row.preview;
          const hasMessage = !!preview?.lastMessage;
          const timestamp = preview?.lastMessage?.created_at;
          const messageText = preview?.lastMessage?.content;
          const isSelected = row.id === selectedPersonaId;

          return (
            <ListItemButton
              key={row.id ?? 'assistant'}
              selected={isSelected}
              onClick={() => handleSelect(row.id)}
              sx={{
                py: 1.5,
                px: 2,
                borderRadius: 1,
                mb: 0.5,
                transition: 'all 150ms ease',
              }}
            >
              {/*
                No avatar. The face was the same face repeated down the list —
                it distinguished nothing and took the width the name and the
                preview needed (#192).
              */}
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 0.25 }}>
                  <Typography
                    variant="body2"
                    sx={{ fontWeight: isSelected ? 700 : 500, fontSize: '0.875rem' }}
                    noWrap
                  >
                    {row.name}
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
