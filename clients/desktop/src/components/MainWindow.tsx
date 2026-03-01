import React, { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  IconButton,
  Alert,
  Tabs,
  Tab,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Tooltip,
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
} from '@mui/icons-material';
import { useConnectionStatus } from '../hooks/useConnectionStatus';
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
import { useMicStore } from '../store/micStore';

type Page = 'chat' | 'settings' | 'agents' | 'tools' | 'faces' | 'extensions';

const TAB_TO_PAGE: Page[] = ['chat', 'agents', 'tools', 'faces', 'extensions'];
const PAGE_TO_TAB: Record<string, number> = { chat: 0, agents: 1, tools: 2, faces: 3, extensions: 4 };

export const MainWindow: React.FC = () => {
  const connectionStatus = useConnectionStatus();
  const { user, logout } = useAuthStore();
  const {
    currentConversation,
    deleteConversation,
  } = useConversationStore();
  const { agents, selectedAgentId, loadAgents, selectAgent } = useAgentStore();
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
    } catch (err: any) {
      setError('Failed to delete conversation');
      console.error(err);
    }
  };

  const handleTabChange = (_: React.SyntheticEvent, newValue: number) => {
    setCurrentPage(TAB_TO_PAGE[newValue]);
  };

  const tabValue = currentPage === 'settings' ? false : PAGE_TO_TAB[currentPage] ?? false;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Top navigation bar */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          borderBottom: '1px solid',
          borderColor: 'divider',
          backgroundColor: '#FFFFFF',
          px: 2,
          minHeight: 48,
          flexShrink: 0,
        }}
      >
        <Tabs
          value={tabValue}
          onChange={handleTabChange}
          sx={{ minHeight: 48, '& .MuiTab-root': { minHeight: 48, textTransform: 'none' } }}
        >
          <Tab icon={<ChatIcon fontSize="small" />} label="Chat" iconPosition="start" />
          <Tab icon={<AgentsIcon fontSize="small" />} label="Agents" iconPosition="start" />
          <Tab icon={<ToolsIcon fontSize="small" />} label="Tools" iconPosition="start" />
          <Tab icon={<FaceIcon fontSize="small" />} label="Faces" iconPosition="start" />
          <Tab icon={<ExtensionsIcon fontSize="small" />} label="Extensions" iconPosition="start" />
        </Tabs>

        {/* Agent selector + clear conversation */}
        {currentPage === 'chat' && agents.length > 0 && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, ml: 2 }}>
            <FormControl size="small" sx={{ minWidth: 160 }}>
              <InputLabel>Agent</InputLabel>
              <Select
                value={selectedAgentId ?? ''}
                label="Agent"
                onChange={(e) => selectAgent(e.target.value as number)}
              >
                {agents.map((agent) => (
                  <MenuItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Tooltip title="Refresh messages">
              <IconButton
                size="small"
                onClick={() => {
                  if (currentConversation) {
                    useConversationStore.getState().loadConversation(currentConversation.id);
                  }
                }}
              >
                <RefreshIcon fontSize="small" />
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
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
        )}

        <Box sx={{ flex: 1 }} />
        <Tooltip title={connectionStatus === 'connected' ? 'Connected' : connectionStatus === 'connecting' ? 'Connecting...' : 'Disconnected'}>
          <Box
            sx={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              mr: 1,
              backgroundColor:
                connectionStatus === 'connected' ? '#4caf50' :
                connectionStatus === 'connecting' ? '#ff9800' :
                '#f44336',
              transition: 'background-color 0.3s',
            }}
          />
        </Tooltip>
        <Typography variant="body2" color="text.secondary" sx={{ mr: 1 }}>
          {user?.username}
        </Typography>
        <IconButton
          onClick={toggleCharacterWindow}
          size="small"
          color={characterWindowOpen ? 'primary' : 'default'}
          title="Character Window"
        >
          <FaceIcon fontSize="small" />
        </IconButton>
        <Tooltip title={interactiveMode ? 'Exit interactive mode' : 'Interactive mode'}>
          <IconButton
            onClick={toggleInteractiveMode}
            size="small"
            sx={{
              color: interactiveMode ? 'error.main' : 'inherit',
            }}
          >
            {interactiveMode ? <PhoneDisabledIcon fontSize="small" /> : <PhoneIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
        <IconButton
          onClick={() => setCurrentPage(currentPage === 'settings' ? 'chat' : 'settings')}
          size="small"
          color={currentPage === 'settings' ? 'primary' : 'default'}
          title="Settings"
        >
          <SettingsIcon fontSize="small" />
        </IconButton>
        <IconButton onClick={logout} size="small" title="Logout">
          <LogoutIcon fontSize="small" />
        </IconButton>
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
