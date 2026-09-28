import React from 'react';
import { Box } from '@mui/material';
import { alpha, type Theme } from '@mui/material/styles';
import CheckIcon from '@mui/icons-material/Check';

/**
 * How the one the chat is on is marked (#348): a blue outline and a tinted
 * row, the same on a persona's card, the Assistant row in Settings → Personas,
 * and the chat header's picker.
 */
export function selectionColors(theme: Theme) {
  const light = theme.palette.mode === 'light';
  return {
    line: light ? '#2563EB' : '#3B82F6',
    background: alpha(theme.palette.info.main, light ? 0.06 : 0.1),
  };
}

/** The "In the chat" chip: who the chat is on, wherever it is chosen (#348). */
export const InTheChatChip: React.FC = () => (
  <Box
    sx={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      height: 24,
      pl: '6px',
      pr: '9px',
      borderRadius: '4px',
      bgcolor: 'primary.main',
      color: 'primary.contrastText',
      fontSize: 12,
      fontWeight: 600,
      flex: 'none',
      whiteSpace: 'nowrap',
    }}
  >
    <CheckIcon aria-hidden sx={{ fontSize: 14 }} />
    In the chat
  </Box>
);
