import React, { useEffect, useRef } from 'react';
import { Box, Typography } from '@mui/material';
import {
  CHARACTER_PANEL_MAX_FRACTION,
  CHARACTER_PANEL_MIN_HEIGHT,
  useConversationStore,
  useCharacterStore,
  useLayoutStore,
} from '@kurisu/state';
import { useCapabilities, useCharacterBridgeSync } from '@kurisu/hooks';
import { resolveBridge } from '@kurisu/platform';
import { ChatWidget } from '../chat/ChatWidget';
import { CharacterPanel } from '../../character/CharacterPanel';
import { ResizeHandle } from './ResizeHandle';

export const ChatPanel: React.FC = () => {
  const { characterWindow: hasCharacterWindow } = useCapabilities();
  const characterVisible = useLayoutStore((s) => s.characterVisible);
  const characterPanelHeight = useLayoutStore((s) => s.characterPanelHeight);
  const windowOpen = useCharacterStore((s) => s.windowOpen);
  const columnRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // The feed to the second window: mirrored while it is open, and its
  // `ready`/session handshake answered, from the one place that owns the
  // window's state (#238).
  useCharacterBridgeSync();

  // /refresh — reload the current conversation
  useEffect(() => {
    const handler = () => {
      const id = useConversationStore.getState().currentConversation?.id;
      if (id) useConversationStore.getState().loadConversation(id);
    };
    window.addEventListener('kurisu:refresh-conversation', handler);
    return () => window.removeEventListener('kurisu:refresh-conversation', handler);
  }, []);

  // The inline panel draws only while the character is not in its own window:
  // one stage per persona at a time (#241). This is also what tells
  // `useCharacterPanel` a surface wants the personas.
  const inlineDrawing = characterVisible && !windowOpen;
  useEffect(() => {
    useCharacterStore.getState().setInlineVisible(inlineDrawing);
  }, [inlineDrawing]);
  useEffect(() => () => useCharacterStore.getState().setInlineVisible(false), []);

  // /live-animate and the Face button on the chat header show and hide the
  // character wherever it is; hiding it while it is in its own window closes
  // the window. The window's own close brings it back into the panel, and a
  // `ready` from a window this renderer thought was closed puts it out again.
  useEffect(() => {
    const api = resolveBridge().characterWindow;
    const toggle = () => {
      const layout = useLayoutStore.getState();
      const { windowOpen: open } = useCharacterStore.getState();
      if (layout.characterVisible || open) {
        layout.setCharacterVisible(false);
        if (open && api) api.close().catch((error) => console.error('Failed to close the character window:', error));
      } else {
        layout.setCharacterVisible(true);
      }
    };
    window.addEventListener('kurisu:toggle-character', toggle);
    if (!hasCharacterWindow || !api) {
      return () => window.removeEventListener('kurisu:toggle-character', toggle);
    }
    const offClosed = api.onWindowClosed(() => useCharacterStore.getState().setWindowOpen(false));
    const offReady = api.onCharacterReady(() => {
      useCharacterStore.getState().setWindowOpen(true);
      useLayoutStore.getState().setCharacterVisible(true);
    });
    return () => {
      window.removeEventListener('kurisu:toggle-character', toggle);
      offClosed();
      offReady();
      useCharacterStore.getState().setWindowOpen(false);
    };
  }, [hasCharacterWindow]);

  // The flag flips before `open()` resolves, so the feed to the window is on
  // before the window can ask for it (#237).
  const popOut = () => {
    const api = resolveBridge().characterWindow;
    if (!api) return;
    useCharacterStore.getState().setWindowOpen(true);
    api.open().catch((error) => {
      console.error('Failed to open the character window:', error);
      useCharacterStore.getState().setWindowOpen(false);
    });
  };
  const popIn = () => {
    const api = resolveBridge().characterWindow;
    if (!api) return;
    api.close()
      .catch((error) => console.error('Failed to close the character window:', error))
      .finally(() => useCharacterStore.getState().setWindowOpen(false));
  };
  const hide = () => window.dispatchEvent(new Event('kurisu:toggle-character'));

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

      <Box ref={columnRef} sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {characterVisible && (
          <CharacterPanel
            ref={panelRef}
            height={characterPanelHeight}
            poppedOut={windowOpen}
            canPopOut={hasCharacterWindow}
            onPopOut={popOut}
            onPopIn={popIn}
            onHide={hide}
          />
        )}
        {characterVisible && !windowOpen && (
          <ResizeHandle
            data-testid="character-panel-resize"
            targetRef={panelRef}
            property="height"
            direction="vertical"
            min={CHARACTER_PANEL_MIN_HEIGHT}
            max={() => (columnRef.current?.clientHeight ?? 0) * CHARACTER_PANEL_MAX_FRACTION}
            onResizeEnd={(height) => {
              useLayoutStore.getState().setCharacterPanelHeight(height);
              useLayoutStore.getState().persistWidths();
            }}
          />
        )}
        <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', minWidth: 0 }}>
          <ChatWidget characterShown={characterVisible || windowOpen} />
        </Box>
      </Box>
    </Box>
  );
};
