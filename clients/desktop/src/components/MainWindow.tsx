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
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  Logout as LogoutIcon,
  Settings as SettingsIcon,
} from '@mui/icons-material';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuthStore } from '../store/authStore';
import { useConversationStore } from '../store/conversationStore';
import { ChatWidget } from './ChatWidget';
import { SettingsWindow } from './SettingsWindow';

const DRAWER_WIDTH = 280;

const MotionListItemButton = motion(ListItemButton);

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

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    loadConversations().catch((err) => {
      setError('Failed to load conversations');
      console.error(err);
    });
  }, [loadConversations]);

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

  const handleConversationCreated = () => {
    loadConversations().catch(console.error);
  };

  return (
    <Box sx={{ display: 'flex', height: '100vh' }}>
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
          },
        }}
      >
        <Box sx={{ p: 2 }}>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            {user?.username}
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
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
          <Box sx={{ position: 'absolute', top: 16, right: 16, display: 'flex', gap: 1 }}>
            <IconButton
              onClick={() => setShowSettings(!showSettings)}
              size="small"
              color={showSettings ? 'primary' : 'default'}
            >
              <SettingsIcon />
            </IconButton>
            <IconButton
              onClick={logout}
              size="small"
            >
              <LogoutIcon />
            </IconButton>
          </Box>
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
                  secondary={`${conv.chunk_count} chunks`}
                  primaryTypographyProps={{ fontSize: '0.875rem' }}
                  secondaryTypographyProps={{ fontSize: '0.75rem' }}
                />
              </MotionListItemButton>
            ))}
          </AnimatePresence>
        </List>
      </Drawer>

      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {error && (
          <Alert severity="error" onClose={() => setError('')}>
            {error}
          </Alert>
        )}
        {showSettings ? (
          <SettingsWindow onBack={() => setShowSettings(false)} />
        ) : (
          <ChatWidget onConversationCreated={handleConversationCreated} />
        )}
      </Box>
    </Box>
  );
};
