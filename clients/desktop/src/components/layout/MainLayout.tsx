import React, { useCallback, useEffect, useState } from 'react';
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
  const { activePage, chatPanelWidth, setChatPanelWidth } = useLayoutStore();
  const { loadAgents, loadAgentPreviews } = useAgentStore();
  const [characterVisible, setCharacterVisible] = useState(false);

  // Load agents on mount
  useEffect(() => {
    loadAgents().then(() => loadAgentPreviews());
  }, [loadAgents, loadAgentPreviews]);

  const handleChatResize = useCallback((delta: number) => {
    setChatPanelWidth(Math.max(MIN_CHAT_WIDTH, Math.min(MAX_CHAT_WIDTH, chatPanelWidth - delta)));
  }, [chatPanelWidth, setChatPanelWidth]);

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
      <ActivityBar
        characterVisible={characterVisible}
        onToggleCharacter={() => setCharacterVisible(!characterVisible)}
      />

      {/* Main content area */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {renderMainContent()}
      </Box>

      {/* Resize handle */}
      <ResizeHandle onResize={handleChatResize} />

      {/* Chat panel */}
      <Box sx={{ width: chatPanelWidth, flexShrink: 0, overflow: 'hidden' }}>
        <ChatPanel />
      </Box>
    </Box>
  );
};
