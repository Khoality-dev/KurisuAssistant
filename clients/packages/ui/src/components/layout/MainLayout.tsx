import React, { useCallback, useEffect, useRef } from 'react';
import { Box } from '@mui/material';
import { ActivityBar } from './ActivityBar';
import { TransferTray } from '../explorer/TransferTray';
import { ChatPanel } from './ChatPanel';
import { ResizeHandle } from './ResizeHandle';
import { useLayoutStore } from '@kurisu/state';
import { usePersonaStore } from '@kurisu/state';
import { ConversationsPage } from '../conversations/ConversationsPage';
import { SettingsPage } from '../settings/SettingsPage';
import { FileExplorerPage } from '../explorer/FileExplorerPage';
import { ScreenErrorBoundary } from '../ScreenErrorBoundary';

const MIN_CHAT_WIDTH = 300;
const MAX_CHAT_WIDTH = 700;

export const MainLayout: React.FC = () => {
  const { activePage, chatPanelWidth } = useLayoutStore();
  const { loadPersonas, loadPersonaPreviews } = usePersonaStore();
  const chatPanelRef = useRef<HTMLDivElement>(null);

  // Load personas on mount
  useEffect(() => {
    loadPersonas().then(() => loadPersonaPreviews());
  }, [loadPersonas, loadPersonaPreviews]);

  const handleChatResizeEnd = useCallback((size: number) => {
    useLayoutStore.getState().setChatPanelWidth(size);
    useLayoutStore.getState().persistWidths();
  }, []);

  const renderMainContent = () => {
    switch (activePage) {
      case 'workspace': return <FileExplorerPage />;
      case 'conversations': return <ConversationsPage />;
      case 'settings': return <SettingsPage />;
    }
  };

  return (
    <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden', bgcolor: 'background.default' }}>
      {/* Activity bar */}
      <ActivityBar />

      {/* Main content area */}
      {/* A page or the chat that throws while rendering stays in its own
          pane rather than blanking the window (#296). */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        <ScreenErrorBoundary key={activePage} label={`the ${activePage} page`}>
          {renderMainContent()}
        </ScreenErrorBoundary>
      </Box>

      {/* Resize handle */}
      <ResizeHandle
        targetRef={chatPanelRef}
        min={MIN_CHAT_WIDTH}
        max={MAX_CHAT_WIDTH}
        invert
        onResizeEnd={handleChatResizeEnd}
      />

      {/* Chat panel */}
      <Box ref={chatPanelRef} sx={{ width: chatPanelWidth, flexShrink: 0, overflow: 'hidden' }}>
        <ScreenErrorBoundary label="the chat panel">
          <ChatPanel />
        </ScreenErrorBoundary>
      </Box>

      {/* Transfers, over everything: a drive transfer outlives the page that
          started it. */}
      <TransferTray />
    </Box>
  );
};
