import React, { useEffect, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { useConversationStore } from '@kurisu/state';
import { useCapabilities } from '@kurisu/hooks';
import { resolveBridge } from '@kurisu/platform';
import { ChatWidget } from '../chat/ChatWidget';

export const ChatPanel: React.FC = () => {
  const { characterWindow: hasCharacterWindow } = useCapabilities();
  const [characterVisible, setCharacterVisible] = useState(false);
  const characterVisibleRef = useRef(false);

  // /refresh — reload the current conversation
  useEffect(() => {
    const handler = () => {
      const id = useConversationStore.getState().currentConversation?.id;
      if (id) useConversationStore.getState().loadConversation(id);
    };
    window.addEventListener('kurisu:refresh-conversation', handler);
    return () => window.removeEventListener('kurisu:refresh-conversation', handler);
  }, []);

  // /live-animate and the Face button on the chat header: open or close the
  // character window. The window is the only character surface today (an
  // inline panel is #241), so a host without one has nothing to toggle. The
  // flag flips before `open()` resolves, so the hook that answers the window's
  // `ready` is subscribed before the window can send it (#237).
  useEffect(() => {
    const api = resolveBridge().characterWindow;
    if (!hasCharacterWindow || !api) return;
    const show = (visible: boolean) => {
      characterVisibleRef.current = visible;
      setCharacterVisible(visible);
    };
    const toggle = () => {
      if (characterVisibleRef.current) {
        api.close().catch((error) => console.error('Failed to close the character window:', error));
      } else {
        show(true);
        api.open().catch((error) => {
          console.error('Failed to open the character window:', error);
          show(false);
        });
      }
    };
    window.addEventListener('kurisu:toggle-character', toggle);
    const offClosed = api.onWindowClosed(() => show(false));
    return () => {
      window.removeEventListener('kurisu:toggle-character', toggle);
      offClosed();
    };
  }, [hasCharacterWindow]);

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
