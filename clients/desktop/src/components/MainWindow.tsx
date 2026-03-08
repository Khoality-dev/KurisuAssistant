import React, { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  IconButton,
  Alert,
  Tabs,
  Tab,
  Tooltip,
  Divider,
} from '@mui/material';
import {
  Delete as DeleteIcon,
  Logout as LogoutIcon,
  Settings as SettingsIcon,
  SmartToy as AgentsIcon,
  Extension as ToolsIcon,
  GetApp as ExtensionsIcon,
  Chat as ChatIcon,
  Face as FaceIcon,
  Refresh as RefreshIcon,
  Phone as PhoneIcon,
  PhoneDisabled as PhoneDisabledIcon,
  Menu as MenuIcon,
} from '@mui/icons-material';
import { useConnectionStatus } from '../hooks/useConnectionStatus';
import { wsManager } from '../api/websocket';
import { useAuthStore } from '../store/authStore';
import { useConversationStore } from '../store/conversationStore';
import { useAgentStore } from '../store/agentStore';
import { storage } from '../utils/storage';
import { ChatWidget } from './ChatWidget';
import { SettingsWindow } from './SettingsWindow';
import { AgentsWindow } from './AgentsWindow';
import { ToolsWindow } from './ToolsWindow';
import { FacesWindow } from './FacesWindow';
import { ExtensionsWindow } from './ExtensionsWindow';
import { MediaPlayerBar } from './MediaPlayerBar';
import { AgentSidebar } from './AgentSidebar';
import { useMicStore } from '../store/micStore';
import { useSidebarStore } from '../store/sidebarStore';

type Page = 'chat' | 'settings' | 'agents' | 'tools' | 'faces' | 'extensions';

const TAB_TO_PAGE: Page[] = ['chat', 'agents', 'tools', 'faces', 'extensions'];
const PAGE_TO_TAB: Record<string, number> = { chat: 0, agents: 1, tools: 2, faces: 3, extensions: 4 };

export const MainWindow: React.FC = () => {
  const connectionStatus = useConnectionStatus();
  const { logout } = useAuthStore();
  const {
    currentConversation,
    deleteConversation,
  } = useConversationStore();
  const { agents, selectedAgentId, loadAgents, selectAgent, loadAgentPreviews } = useAgentStore();
  const sidebarToggle = useSidebarStore((s) => s.toggle);
  const { interactiveMode, enableInteractiveMode, disableInteractiveMode } = useMicStore();
  const toggleInteractiveMode = () => interactiveMode ? disableInteractiveMode() : enableInteractiveMode();

  const [characterWindowOpen, setCharacterWindowOpen] = useState(false);

  // Listen for character window being closed externally (via X button)
  useEffect(() => {
    const api = window.electron?.characterWindow;
    if (!api) return;
    const cleanup = api.onWindowClosed(() => {
      setCharacterWindowOpen(false);
    });
    return cleanup;
  }, []);

  const toggleCharacterWindow = async () => {
    const api = window.electron?.characterWindow;
    if (!api) return;
    if (characterWindowOpen) {
      await api.close();
      setCharacterWindowOpen(false);
    } else {
      await api.open();
      setCharacterWindowOpen(true);
    }
  };

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;

  const [error, setError] = useState('');
  const [currentPage, setCurrentPage] = useState<Page>('chat');

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  const handleClearConversation = async () => {
    if (!currentConversation) return;
    try {
      await deleteConversation(currentConversation.id);
      if (selectedAgentId !== null) {
        storage.clearAgentConversationId(selectedAgentId);
      } else {
        storage.clearAgentConversationId('group');
      }
      loadAgentPreviews();
    } catch (err: any) {
      setError('Failed to delete conversation');
      console.error(err);
    }
  };

  const handleSidebarSelectAgent = (id: number) => {
    selectAgent(id);
    setCurrentPage('chat');
  };

  const handleTabChange = (_: React.SyntheticEvent, newValue: number) => {
    setCurrentPage(TAB_TO_PAGE[newValue]);
  };

  const tabValue = currentPage === 'settings' ? false : PAGE_TO_TAB[currentPage] ?? false;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <AgentSidebar onSelectAgent={handleSidebarSelectAgent} />
      {/* Top navigation bar */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          borderBottom: '1px solid',
          borderColor: 'divider',
          backgroundColor: '#FFFFFF',
          px: 1,
          minHeight: 48,
          flexShrink: 0,
          gap: 0,
        }}
      >
        {/* Left zone: Hamburger + agent name (Chat tab only) */}
        {currentPage === 'chat' && (
          <>
            <Tooltip title="Conversations">
              <IconButton size="small" onClick={sidebarToggle} sx={{ mr: 0.5 }}>
                <MenuIcon sx={{ fontSize: 20 }} />
              </IconButton>
            </Tooltip>
            {selectedAgent && (
              <Typography variant="body2" sx={{ fontWeight: 600, maxWidth: 120, mr: 0.5 }} noWrap>
                {selectedAgent.name}
              </Typography>
            )}
            <Divider orientation="vertical" flexItem sx={{ mx: 0.5, my: 1 }} />
          </>
        )}

        {/* Center zone: Navigation tabs */}
        <Tabs
          value={tabValue}
          onChange={handleTabChange}
          sx={{ minHeight: 48, flex: 1, '& .MuiTab-root': { minHeight: 48, minWidth: 'auto', textTransform: 'none', px: 1.5 } }}
        >
          <Tab icon={<ChatIcon fontSize="small" />} label="Chat" iconPosition="start" />
          <Tab icon={<AgentsIcon fontSize="small" />} label="Agents" iconPosition="start" />
          <Tab icon={<ToolsIcon fontSize="small" />} label="Tools" iconPosition="start" />
          <Tab icon={<FaceIcon fontSize="small" />} label="Faces" iconPosition="start" />
          <Tab icon={<ExtensionsIcon fontSize="small" />} label="Extensions" iconPosition="start" />
        </Tabs>

        {/* Right zone: Context actions + global utilities */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, flexShrink: 0 }}>
          {/* Conversation actions (Chat tab only) */}
          {currentPage === 'chat' && (
            <>
              <Tooltip title="Refresh messages">
                <IconButton
                  size="small"
                  onClick={() => {
                    if (currentConversation) {
                      useConversationStore.getState().loadConversation(currentConversation.id);
                    }
                  }}
                >
                  <RefreshIcon sx={{ fontSize: 18 }} />
                </IconButton>
              </Tooltip>
              <Tooltip title="Clear conversation">
                <span>
                  <IconButton
                    size="small"
                    onClick={handleClearConversation}
                    disabled={!currentConversation}
                    color="error"
                  >
                    <DeleteIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <Divider orientation="vertical" flexItem sx={{ mx: 0.5, my: 1 }} />
            </>
          )}

          {/* Connection status */}
          <Tooltip title={connectionStatus === 'connected' ? 'Connected' : connectionStatus === 'connecting' ? 'Connecting...' : 'Disconnected — click to reconnect'}>
            <Box
              onClick={() => {
                if (connectionStatus === 'disconnected') {
                  wsManager.reconnect();
                }
              }}
              sx={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                mx: 0.5,
                backgroundColor:
                  connectionStatus === 'connected' ? '#4caf50' :
                  connectionStatus === 'connecting' ? '#ff9800' :
                  '#f44336',
                transition: 'background-color 0.3s',
                cursor: connectionStatus === 'disconnected' ? 'pointer' : 'default',
              }}
            />
          </Tooltip>

          {/* Global utility buttons */}
          <IconButton
            onClick={toggleCharacterWindow}
            size="small"
            color={characterWindowOpen ? 'primary' : 'default'}
            title="Character Window"
          >
            <FaceIcon sx={{ fontSize: 18 }} />
          </IconButton>
          <Tooltip title={interactiveMode ? 'Exit interactive mode' : 'Interactive mode'}>
            <IconButton
              onClick={toggleInteractiveMode}
              size="small"
              sx={{ color: interactiveMode ? 'error.main' : 'inherit' }}
            >
              {interactiveMode ? <PhoneDisabledIcon sx={{ fontSize: 18 }} /> : <PhoneIcon sx={{ fontSize: 18 }} />}
            </IconButton>
          </Tooltip>
          <IconButton
            onClick={() => setCurrentPage(currentPage === 'settings' ? 'chat' : 'settings')}
            size="small"
            color={currentPage === 'settings' ? 'primary' : 'default'}
            title="Settings"
          >
            <SettingsIcon sx={{ fontSize: 18 }} />
          </IconButton>
          <IconButton onClick={logout} size="small" title="Logout">
            <LogoutIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Box>
      </Box>

      {/* Content area */}
      <Box sx={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Main content */}
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {error && (
            <Alert severity="error" onClose={() => setError('')}>
              {error}
            </Alert>
          )}
          <Box sx={{ flex: 1, display: currentPage === 'chat' ? 'flex' : 'none', flexDirection: 'column', overflow: 'hidden' }}>
            <ChatWidget characterWindowOpen={characterWindowOpen} agentId={selectedAgentId} />
          </Box>
          <Box sx={{ flex: 1, display: currentPage === 'agents' ? 'flex' : 'none', flexDirection: 'column', overflow: 'hidden' }}>
            <AgentsWindow />
          </Box>
          <Box sx={{ flex: 1, display: currentPage === 'tools' ? 'flex' : 'none', flexDirection: 'column', overflow: 'hidden' }}>
            <ToolsWindow />
          </Box>
          <Box sx={{ flex: 1, display: currentPage === 'faces' ? 'flex' : 'none', flexDirection: 'column', overflow: 'hidden' }}>
            <FacesWindow />
          </Box>
          <Box sx={{ flex: 1, display: currentPage === 'extensions' ? 'flex' : 'none', flexDirection: 'column', overflow: 'hidden' }}>
            <ExtensionsWindow />
          </Box>
          {currentPage === 'settings' && (
            <SettingsWindow onBack={() => setCurrentPage('chat')} />
          )}
          <MediaPlayerBar />
        </Box>
      </Box>
    </Box>
  );
};
