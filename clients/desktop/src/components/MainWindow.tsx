import React, { useEffect, useState } from 'react';
import {
  Box,
  Drawer,
  List,
  ListItemButton,
  ListItemText,
  Button,
  Typography,
  IconButton,
  Divider,
  Alert,
  Tabs,
  Tab,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Tooltip,
  ToggleButtonGroup,
  ToggleButton,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  Logout as LogoutIcon,
  Settings as SettingsIcon,
  SmartToy as AgentsIcon,
  Extension as ToolsIcon,
  Chat as ChatIcon,
  Face as FaceIcon,
  Person as PersonIcon,
  Groups as GroupsIcon,
} from '@mui/icons-material';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuthStore } from '../store/authStore';
import { useConversationStore } from '../store/conversationStore';
import { useAgentStore } from '../store/agentStore';
import { ChatWidget } from './ChatWidget';
import { SettingsWindow } from './SettingsWindow';
import { AgentsWindow } from './AgentsWindow';
import { ToolsWindow } from './ToolsWindow';

const DRAWER_WIDTH = 280;

const MotionListItemButton = motion(ListItemButton);

type Page = 'chat' | 'settings' | 'agents' | 'tools';

const TAB_TO_PAGE: Page[] = ['chat', 'agents', 'tools'];
const PAGE_TO_TAB: Record<string, number> = { chat: 0, agents: 1, tools: 2 };

export const MainWindow: React.FC = () => {
  const { user, logout } = useAuthStore();
  const {
    conversations,
    currentConversation,
    loadConversations,
    loadConversation,
    deleteConversation,
    createNewConversation,
  } = useConversationStore();
  const { agents, selectedAgentId, loadAgents, selectAgent } = useAgentStore();

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

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [currentPage, setCurrentPage] = useState<Page>('chat');

  useEffect(() => {
    loadConversations().catch((err) => {
      setError('Failed to load conversations');
      console.error(err);
    });
    loadAgents();
  }, [loadConversations, loadAgents]);

  const handleSelectConversation = async (id: number) => {
    try {
      setSelectedId(id);
      await loadConversation(id);
    } catch (err: any) {
      setError('Failed to load conversation');
      console.error(err);
    }
  };

  const handleNewConversation = () => {
    setSelectedId(null);
    createNewConversation();
  };

  const handleDelete = async () => {
    if (selectedId !== null) {
      try {
        await deleteConversation(selectedId);
        setSelectedId(null);
      } catch (err: any) {
        setError('Failed to delete conversation');
        console.error(err);
      }
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
        </Tabs>
        <Box sx={{ flex: 1 }} />
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
        {/* Sidebar - only visible on Chat tab */}
        {currentPage === 'chat' && (
          <Drawer
            variant="permanent"
            sx={{
              width: DRAWER_WIDTH,
              flexShrink: 0,
              '& .MuiDrawer-paper': {
                width: DRAWER_WIDTH,
                boxSizing: 'border-box',
                backgroundColor: '#F9F9F9',
                borderRight: '1px solid #E5E5E5',
                position: 'relative',
              },
            }}
          >
            <Box sx={{ p: 2 }}>
              {/* Action buttons */}
              <Box sx={{ display: 'flex', gap: 1 }}>
                <Button
                  fullWidth
                  variant="contained"
                  startIcon={<AddIcon />}
                  onClick={handleNewConversation}
                >
                  New
                </Button>
                <IconButton
                  color="error"
                  onClick={handleDelete}
                  disabled={selectedId === null}
                  sx={{ border: '1px solid', borderColor: 'divider' }}
                >
                  <DeleteIcon />
                </IconButton>
              </Box>

              {/* Mode selector */}
              <ToggleButtonGroup
                value="single"
                exclusive
                fullWidth
                size="small"
                sx={{ mt: 1.5 }}
              >
                <ToggleButton
                  value="single"
                  sx={{ textTransform: 'none', fontSize: '0.75rem', py: 0.5 }}
                >
                  <PersonIcon sx={{ fontSize: 16, mr: 0.5 }} />
                  Single Agent
                </ToggleButton>
                <Tooltip title="Group discussion mode coming soon">
                  <span style={{ flex: 1, display: 'flex' }}>
                    <ToggleButton
                      value="group"
                      disabled
                      sx={{ textTransform: 'none', fontSize: '0.75rem', py: 0.5, flex: 1 }}
                    >
                      <GroupsIcon sx={{ fontSize: 16, mr: 0.5 }} />
                      Group
                    </ToggleButton>
                  </span>
                </Tooltip>
              </ToggleButtonGroup>

              {/* Agent selector */}
              {agents.length > 0 && (
                <FormControl fullWidth size="small" sx={{ mt: 1.5 }}>
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
              )}
            </Box>

            <Divider />

            <Typography
              variant="caption"
              sx={{ px: 2, py: 1, color: 'text.secondary', fontWeight: 600 }}
            >
              CONVERSATIONS
            </Typography>

            <List sx={{ px: 1, flex: 1, overflow: 'auto' }}>
              <AnimatePresence>
                {conversations.map((conv) => (
                  <MotionListItemButton
                    key={conv.id}
                    selected={selectedId === conv.id}
                    onClick={() => handleSelectConversation(conv.id)}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ duration: 0.2 }}
                  >
                    <ListItemText
                      primary={conv.title}
                      secondary={`${conv.frame_count} frames`}
                      primaryTypographyProps={{ fontSize: '0.875rem' }}
                      secondaryTypographyProps={{ fontSize: '0.75rem' }}
                    />
                  </MotionListItemButton>
                ))}
              </AnimatePresence>
            </List>
          </Drawer>
        )}

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
          {currentPage === 'settings' && (
            <SettingsWindow onBack={() => setCurrentPage('chat')} />
          )}
        </Box>
      </Box>
    </Box>
  );
};
