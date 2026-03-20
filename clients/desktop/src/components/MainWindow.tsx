import React, { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  IconButton,
  Button,
  Alert,
  Tabs,
  Tab,
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
  const activeAgentLabel = selectedAgent?.name || 'Group Chat';
  const workspaceLabel = selectedAgent ? 'Agent Workspace' : 'Routing Workspace';
  const connectionColor =
    connectionStatus === 'connected' ? '#16A34A' :
    connectionStatus === 'connecting' ? '#F59E0B' :
    '#EF4444';
  const shellPanelSx = {
    backgroundColor: '#FFFFFF',
    borderBottom: '1px solid',
    borderColor: '#E2E8F0',
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: '#F8FAFC' }}>
      <AgentSidebar onSelectAgent={handleSidebarSelectAgent} />

      <Box
        sx={{
          ...shellPanelSx,
          px: 2,
          py: 1.25,
          flexShrink: 0,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              minHeight: 44,
            }}
          >
            <Tabs
              value={tabValue}
              onChange={handleTabChange}
              sx={{
                minHeight: 44,
                '& .MuiTabs-indicator': { display: 'none' },
                '& .MuiTab-root': {
                  minHeight: 44,
                  minWidth: 'auto',
                  textTransform: 'none',
                  px: 2,
                  borderRadius: 0,
                  color: '#64748B',
                  borderBottom: '2px solid transparent',
                },
                '& .Mui-selected': {
                  color: '#0F172A',
                  borderBottomColor: '#2563EB',
                  backgroundColor: '#F8FAFC',
                },
              }}
            >
              <Tab icon={<ChatIcon fontSize="small" />} label="Chat" iconPosition="start" />
              <Tab icon={<AgentsIcon fontSize="small" />} label="Agents" iconPosition="start" />
              <Tab icon={<ToolsIcon fontSize="small" />} label="Tools" iconPosition="start" />
              <Tab icon={<FaceIcon fontSize="small" />} label="Faces" iconPosition="start" />
              <Tab icon={<ExtensionsIcon fontSize="small" />} label="Extensions" iconPosition="start" />
            </Tabs>
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <Tooltip title={connectionStatus === 'connected' ? 'Connected' : connectionStatus === 'connecting' ? 'Connecting...' : 'Disconnected - click to reconnect'}>
              <Button
                size="small"
                variant="text"
                onClick={() => {
                  if (connectionStatus === 'disconnected') {
                    wsManager.reconnect();
                  }
                }}
                sx={{
                  minWidth: 'auto',
                  px: 1.25,
                  py: 0.6,
                  color: '#475569',
                  backgroundColor: 'transparent',
                  borderRadius: 0,
                  '&:hover': {
                    backgroundColor: '#F1F5F9',
                  },
                }}
              >
                <Box sx={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: connectionColor, mr: 1 }} />
                {connectionStatus === 'connected' ? 'Online' : connectionStatus === 'connecting' ? 'Connecting' : 'Offline'}
              </Button>
            </Tooltip>

            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.25,
                px: 0,
                py: 0,
              }}
            >
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
        </Box>
      </Box>

      {currentPage === 'chat' && (
        <Box
          sx={{
            ...shellPanelSx,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 2,
            flexWrap: 'wrap',
            px: 2.5,
            py: 1.25,
            flexShrink: 0,
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0, flex: 1 }}>
            <IconButton
              onClick={sidebarToggle}
              size="small"
              sx={{
                width: 40,
                height: 40,
                borderRadius: 0,
                border: '1px solid',
                borderColor: '#E2E8F0',
                color: '#0F172A',
                flexShrink: 0,
                '&:hover': {
                  backgroundColor: '#F1F5F9',
                },
              }}
            >
              <MenuIcon sx={{ fontSize: 18 }} />
            </IconButton>

            <Box
              sx={{
                width: 10,
                height: 40,
                backgroundColor: '#0F172A',
                flexShrink: 0,
              }}
            />

            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography
                variant="overline"
                sx={{
                  display: 'block',
                  lineHeight: 1,
                  letterSpacing: '0.12em',
                  color: '#64748B',
                  mb: 0.75,
                }}
              >
                {workspaceLabel}
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.25, minWidth: 0, flexWrap: 'wrap' }}>
                <Typography variant="body1" sx={{ fontWeight: 700, color: '#0F172A' }} noWrap>
                  {activeAgentLabel}
                </Typography>
                {!selectedAgent && (
                  <Typography variant="caption" color="text.secondary" noWrap>
                    Administrator routing enabled
                  </Typography>
                )}
              </Box>
            </Box>
          </Box>

          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              px: 0,
              py: 0,
            }}
          >
            <Tooltip title="Refresh messages">
              <span>
                <IconButton
                  size="small"
                  onClick={() => {
                    if (currentConversation) {
                      useConversationStore.getState().loadConversation(currentConversation.id);
                    }
                  }}
                  disabled={!currentConversation}
                >
                  <RefreshIcon sx={{ fontSize: 18 }} />
                </IconButton>
              </span>
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
          </Box>
        </Box>
      )}

      <Box sx={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
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
