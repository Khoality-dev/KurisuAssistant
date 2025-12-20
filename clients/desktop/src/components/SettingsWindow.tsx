import React, { useState, useEffect, useRef } from 'react';
import {
  Box,
  Paper,
  Typography,
  TextField,
  Button,
  Avatar,
  IconButton,
  Alert,
} from '@mui/material';
import {
  ArrowBack as ArrowBackIcon,
  PhotoCamera as PhotoCameraIcon,
  Save as SaveIcon,
} from '@mui/icons-material';
import { motion } from 'framer-motion';
import { useAuthStore } from '../store/authStore';
import { apiClient } from '../api/client';
import { config } from '../config';

const MotionPaper = motion(Paper);

interface SettingsWindowProps {
  onBack: () => void;
}

export const SettingsWindow: React.FC<SettingsWindowProps> = ({ onBack }) => {
  const { user, loadUserProfile } = useAuthStore();

  const [systemPrompt, setSystemPrompt] = useState('');
  const [preferredName, setPreferredName] = useState('');
  const [userAvatarFile, setUserAvatarFile] = useState<File | null>(null);
  const [agentAvatarFile, setAgentAvatarFile] = useState<File | null>(null);
  const [userAvatarPreview, setUserAvatarPreview] = useState<string | null>(null);
  const [agentAvatarPreview, setAgentAvatarPreview] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const userAvatarInputRef = useRef<HTMLInputElement>(null);
  const agentAvatarInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (user) {
      setSystemPrompt(user.system_prompt || '');
      setPreferredName(user.preferred_name || '');

      if (user.user_avatar_uuid) {
        setUserAvatarPreview(apiClient.getImageUrl(user.user_avatar_uuid));
      }
      if (user.agent_avatar_uuid || user.assistant_avatar_uuid) {
        const avatarUuid = user.agent_avatar_uuid || user.assistant_avatar_uuid;
        setAgentAvatarPreview(apiClient.getImageUrl(avatarUuid!));
      }
    }
  }, [user]);

  const handleUserAvatarSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setUserAvatarFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setUserAvatarPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleAgentAvatarSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setAgentAvatarFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setAgentAvatarPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSuccessMessage('');
    setErrorMessage('');

    try {
      const formData = new FormData();

      // Add text fields
      if (systemPrompt) {
        formData.append('system_prompt', systemPrompt);
      }
      if (preferredName) {
        formData.append('preferred_name', preferredName);
      }

      // Add avatar files if selected
      if (userAvatarFile) {
        formData.append('user_avatar', userAvatarFile);
      }
      if (agentAvatarFile) {
        formData.append('agent_avatar', agentAvatarFile);
      }

      await apiClient.updateUserProfile(formData);
      await loadUserProfile(); // Reload user profile to get updated data

      setSuccessMessage('Settings saved successfully!');
      setUserAvatarFile(null);
      setAgentAvatarFile(null);

      // Clear success message after 3 seconds
      setTimeout(() => setSuccessMessage(''), 3000);
    } catch (error: any) {
      console.error('Failed to save settings:', error);
      setErrorMessage(error.message || 'Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <Paper
        elevation={0}
        sx={{
          p: 2,
          borderBottom: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          gap: 2,
        }}
      >
        <IconButton onClick={onBack}>
          <ArrowBackIcon />
        </IconButton>
        <Typography variant="h6">Settings</Typography>
      </Paper>

      {/* Content */}
      <Box sx={{ flex: 1, overflow: 'auto', p: 3, backgroundColor: '#F7F7F8' }}>
        <MotionPaper
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          elevation={1}
          sx={{ maxWidth: 800, mx: 'auto', p: 4 }}
        >
          {/* Alert messages */}
          {successMessage && (
            <Alert severity="success" sx={{ mb: 3 }}>
              {successMessage}
            </Alert>
          )}
          {errorMessage && (
            <Alert severity="error" sx={{ mb: 3 }}>
              {errorMessage}
            </Alert>
          )}

          {/* User Avatar */}
          <Box sx={{ mb: 4 }}>
            <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 2 }}>
              Your Avatar
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Avatar
                src={userAvatarPreview || undefined}
                sx={{ width: 80, height: 80 }}
              >
                {!userAvatarPreview && (user?.username?.[0] || 'U')}
              </Avatar>
              <input
                ref={userAvatarInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={handleUserAvatarSelect}
              />
              <Button
                variant="outlined"
                startIcon={<PhotoCameraIcon />}
                onClick={() => userAvatarInputRef.current?.click()}
              >
                Upload Avatar
              </Button>
            </Box>
          </Box>

          {/* Agent Avatar */}
          <Box sx={{ mb: 4 }}>
            <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 2 }}>
              Agent Avatar
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Avatar
                src={agentAvatarPreview || undefined}
                sx={{ width: 80, height: 80, bgcolor: 'primary.main' }}
              >
                {!agentAvatarPreview && 'A'}
              </Avatar>
              <input
                ref={agentAvatarInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={handleAgentAvatarSelect}
              />
              <Button
                variant="outlined"
                startIcon={<PhotoCameraIcon />}
                onClick={() => agentAvatarInputRef.current?.click()}
              >
                Upload Avatar
              </Button>
            </Box>
          </Box>

          {/* Preferred Name */}
          <Box sx={{ mb: 4 }}>
            <TextField
              label="Preferred Name"
              value={preferredName}
              onChange={(e) => setPreferredName(e.target.value)}
              fullWidth
              helperText="How the agent should address you"
            />
          </Box>

          {/* System Prompt */}
          <Box sx={{ mb: 4 }}>
            <TextField
              label="System Prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              multiline
              rows={8}
              fullWidth
              helperText="Custom instructions for the agent's behavior"
            />
          </Box>

          {/* Save Button */}
          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              variant="contained"
              startIcon={<SaveIcon />}
              onClick={handleSave}
              disabled={isSaving}
            >
              {isSaving ? 'Saving...' : 'Save Settings'}
            </Button>
          </Box>
        </MotionPaper>
      </Box>
    </Box>
  );
};
