import React, { useEffect, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { useConversationStore } from '../../store/conversationStore';
import { ChatWidget } from '../chat/ChatWidget';

export const ChatPanel: React.FC = () => {
  const [characterVisible, setCharacterVisible] = useState(false);

  // /refresh — reload the current conversation
  useEffect(() => {
    const handler = () => {
      const id = useConversationStore.getState().currentConversation?.id;
      if (id) useConversationStore.getState().loadConversation(id);
    };
    window.addEventListener('kurisu:refresh-conversation', handler);
    return () => window.removeEventListener('kurisu:refresh-conversation', handler);
  }, []);

  // /character — toggle the character window
  useEffect(() => {
    const handler = () => setCharacterVisible((v) => !v);
    window.addEventListener('kurisu:toggle-character', handler);
    return () => window.removeEventListener('kurisu:toggle-character', handler);
  }, []);

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
      <Box
        sx={{
          px: 2,
          py: 1.5,
          borderBottom: 1,
          borderColor: 'divider',
          flexShrink: 0,
        }}
      >
        <Typography variant="body1" sx={{ fontWeight: 600 }}>
          Chat
        </Typography>
      </Box>

      <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex', minWidth: 0 }}>
        <ChatWidget characterWindowOpen={characterVisible} />
      </Box>
    </Box>
  );
};
