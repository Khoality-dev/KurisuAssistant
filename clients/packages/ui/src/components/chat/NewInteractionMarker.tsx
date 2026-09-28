import React from 'react';
import { Box, Link } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import AddCommentIcon from '@mui/icons-material/AddComment';
import { displayWakeWord, voiceColors } from '../VoiceModeBar';

interface NewInteractionMarkerProps {
  wakeWord: string | null;
  /** When the wake word was heard. */
  at: number;
  /** There was a conversation open before this one, now kept in Conversations. */
  hasPrevious: boolean;
  onOpenConversations: () => void;
}

/**
 * Each interaction is a new conversation (#253), so the transcript opens on a
 * marker that says so (#345): when the wake word was heard, and where the
 * previous conversation is kept, one click away.
 */
export const NewInteractionMarker: React.FC<NewInteractionMarkerProps> = ({ wakeWord, at, hasPrevious, onOpenConversations }) => {
  const c = voiceColors(useTheme());
  const time = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', pb: '4px', mb: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%' }}>
        <Box sx={{ flex: 1, height: '1px', bgcolor: c.line2 }} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 12, fontWeight: 600 }}>
          <AddCommentIcon aria-hidden sx={{ fontSize: 15, color: c.infoFg }} />
          New conversation
        </Box>
        <Box sx={{ flex: 1, height: '1px', bgcolor: c.line2 }} />
      </Box>
      <Box sx={{ fontSize: 12, lineHeight: 1.5, color: 'text.secondary', textAlign: 'center' }}>
        You said “{displayWakeWord(wakeWord)}” at {time}.
        {hasPrevious && (
          <>
            {' '}The last one is in{' '}
            <Link component="button" underline="hover" onClick={onOpenConversations} sx={{ color: c.infoFg, fontWeight: 600, fontSize: 'inherit', verticalAlign: 'baseline' }}>
              Conversations
            </Link>
            .
          </>
        )}
      </Box>
    </Box>
  );
};
