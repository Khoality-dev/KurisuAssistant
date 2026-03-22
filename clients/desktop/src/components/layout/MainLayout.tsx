import React, { useCallback, useEffect, useState } from 'react';
import { Box } from '@mui/material';
import { ActivityBar } from './ActivityBar';
import { ChatPanel } from './ChatPanel';
import { ResizeHandle } from './ResizeHandle';
import { useLayoutStore } from '../../store/layoutStore';
import { useAgentStore } from '../../store/agentStore';

// Placeholder pages — will be replaced with real implementations
const ExplorerPlaceholder = () => (
  <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'text.secondary' }}>
    File Explorer (coming soon)
  </Box>
);

const ConversationsPlaceholder = () => (
  <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'text.secondary' }}>
    Conversations (coming soon)
  </Box>
);

const SettingsPlaceholder = () => (
  <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'text.secondary' }}>
    Settings (coming soon)
  </Box>
);

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
      case 'explorer': return <ExplorerPlaceholder />;
      case 'conversations': return <ConversationsPlaceholder />;
      case 'settings': return <SettingsPlaceholder />;
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
