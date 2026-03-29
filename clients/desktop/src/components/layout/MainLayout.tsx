import React, { useCallback, useEffect, useRef } from 'react';
import { Box } from '@mui/material';
import { ActivityBar } from './ActivityBar';
import { ChatPanel } from './ChatPanel';
import { ResizeHandle } from './ResizeHandle';
import { useLayoutStore } from '../../store/layoutStore';
import { useAgentStore } from '../../store/agentStore';
import { ConversationsPage } from '../conversations/ConversationsPage';
import { SettingsPage } from '../settings/SettingsPage';
import { FileExplorerPage } from '../explorer/FileExplorerPage';

const MIN_CHAT_WIDTH = 300;
const MAX_CHAT_WIDTH = 700;

export const MainLayout: React.FC = () => {
  const { activePage, chatPanelWidth } = useLayoutStore();
  const { loadAgents, loadAgentPreviews } = useAgentStore();
  const chatPanelRef = useRef<HTMLDivElement>(null);

  // Load agents on mount
  useEffect(() => {
    loadAgents().then(() => loadAgentPreviews());
  }, [loadAgents, loadAgentPreviews]);

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
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        {renderMainContent()}
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
        <ChatPanel />
      </Box>
    </Box>
  );
};
