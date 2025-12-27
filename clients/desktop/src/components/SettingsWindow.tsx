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
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  FormControlLabel,
  Switch,
  Divider,
  Tabs,
  Tab,
} from '@mui/material';
import {
  ArrowBack as ArrowBackIcon,
  PhotoCamera as PhotoCameraIcon,
  Save as SaveIcon,
  AccountCircle as AccountCircleIcon,
  VolumeUp as VolumeUpIcon,
} from '@mui/icons-material';
import { motion } from 'framer-motion';
import { useAuthStore } from '../store/authStore';
import { apiClient } from '../api/client';
import { config } from '../config';
import { useTTS } from '../hooks/useTTS';
import { storage } from '../utils/storage';

const MotionPaper = motion(Paper);

interface SettingsWindowProps {
  onBack: () => void;
}

export const SettingsWindow: React.FC<SettingsWindowProps> = ({ onBack }) => {
  const { user, loadUserProfile } = useAuthStore();
  const { voices, loadVoices, backends, loadBackends } = useTTS();

  const [currentTab, setCurrentTab] = useState(0);

  const [systemPrompt, setSystemPrompt] = useState('');
  const [preferredName, setPreferredName] = useState('');
  const [userAvatarFile, setUserAvatarFile] = useState<File | null>(null);
  const [agentAvatarFile, setAgentAvatarFile] = useState<File | null>(null);
  const [userAvatarPreview, setUserAvatarPreview] = useState<string | null>(null);
  const [agentAvatarPreview, setAgentAvatarPreview] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  // TTS settings
  const [ttsBackend, setTtsBackend] = useState(storage.getTTSBackend() || 'gpt-sovits');
  const [ttsVoice, setTtsVoice] = useState(storage.getTTSVoice() || '');
  const [ttsLanguage, setTtsLanguage] = useState(storage.getTTSLanguage() || 'ja');
  const [ttsAutoPlay, setTtsAutoPlay] = useState(storage.getTTSAutoPlay());

  // INDEX-TTS emotion settings
  const [ttsEmotionAudio, setTtsEmotionAudio] = useState(storage.getTTSEmotionAudio() || '');
  const [ttsEmotionAlpha, setTtsEmotionAlpha] = useState(storage.getTTSEmotionAlpha());
  const [ttsUseEmotionText, setTtsUseEmotionText] = useState(storage.getTTSUseEmotionText());

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

  // Load TTS voices and backends on mount
  useEffect(() => {
    loadVoices();
    loadBackends();
  }, [loadVoices, loadBackends]);

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

  const handleSaveAccountSettings = async () => {
    setIsSaving(true);
    setSuccessMessage('');
    setErrorMessage('');

    try {
      // Update text fields (JSON request - PATCH /users/me)
      const profileUpdates: Partial<UserProfile> = {};
      if (systemPrompt !== undefined && systemPrompt !== '') {
        profileUpdates.system_prompt = systemPrompt;
      }
      if (preferredName !== undefined && preferredName !== '') {
        profileUpdates.preferred_name = preferredName;
      }

      if (Object.keys(profileUpdates).length > 0) {
        await apiClient.updateUserProfile(profileUpdates);
      }

      // Update avatars (multipart request - PATCH /users/me/avatars)
      if (userAvatarFile || agentAvatarFile) {
        await apiClient.updateUserAvatars(userAvatarFile || undefined, agentAvatarFile || undefined);
      }

      await loadUserProfile(); // Reload user profile to get updated data

      setSuccessMessage('Account settings saved successfully!');
      setUserAvatarFile(null);
      setAgentAvatarFile(null);

      // Clear success message after 3 seconds
      setTimeout(() => setSuccessMessage(''), 3000);
    } catch (error: any) {
      console.error('Failed to save account settings:', error);
      setErrorMessage(error.message || 'Failed to save account settings');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveTTSSettings = () => {
    try {
      // Save TTS settings to localStorage only
      storage.setTTSBackend(ttsBackend);
      storage.setTTSVoice(ttsVoice);
      storage.setTTSLanguage(ttsLanguage);
      storage.setTTSAutoPlay(ttsAutoPlay);

      // Save INDEX-TTS emotion settings
      storage.setTTSEmotionAudio(ttsEmotionAudio);
      storage.setTTSEmotionAlpha(ttsEmotionAlpha);
      storage.setTTSUseEmotionText(ttsUseEmotionText);

      setSuccessMessage('TTS settings saved successfully!');
      setTimeout(() => setSuccessMessage(''), 3000);
    } catch (error: any) {
      console.error('Failed to save TTS settings:', error);
      setErrorMessage(error.message || 'Failed to save TTS settings');
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

      {/* Tabs */}
      <Paper elevation={0} sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <Tabs value={currentTab} onChange={(_, newValue) => setCurrentTab(newValue)}>
          <Tab icon={<AccountCircleIcon />} label="Account" iconPosition="start" />
          <Tab icon={<VolumeUpIcon />} label="TTS" iconPosition="start" />
        </Tabs>
      </Paper>

      {/* Content */}
      <Box sx={{ flex: 1, overflow: 'auto', p: 3, backgroundColor: '#F7F7F8' }}>
        {/* Alert messages */}
        {successMessage && (
          <Alert severity="success" sx={{ mb: 3, maxWidth: 800, mx: 'auto' }}>
            {successMessage}
          </Alert>
        )}
        {errorMessage && (
          <Alert severity="error" sx={{ mb: 3, maxWidth: 800, mx: 'auto' }}>
            {errorMessage}
          </Alert>
        )}

        {/* Account Settings Tab */}
        {currentTab === 0 && (
          <MotionPaper
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
            elevation={1}
            sx={{ maxWidth: 800, mx: 'auto', p: 4 }}
          >
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

          {/* Save Account Settings Button */}
          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              variant="contained"
              startIcon={<SaveIcon />}
              onClick={handleSaveAccountSettings}
              disabled={isSaving}
            >
              {isSaving ? 'Saving...' : 'Save Account Settings'}
            </Button>
          </Box>
        </MotionPaper>
        )}

        {/* TTS Settings Tab */}
        {currentTab === 1 && (
          <MotionPaper
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
            elevation={1}
            sx={{ maxWidth: 800, mx: 'auto', p: 4 }}
          >

          {/* TTS Backend */}
          <Box sx={{ mb: 3 }}>
            <FormControl fullWidth>
              <InputLabel>TTS Backend</InputLabel>
              <Select
                value={ttsBackend}
                label="TTS Backend"
                onChange={(e) => setTtsBackend(e.target.value)}
              >
                {backends.map((backend) => (
                  <MenuItem key={backend} value={backend}>
                    {backend}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>

          {/* TTS Voice */}
          <Box sx={{ mb: 3 }}>
            <FormControl fullWidth>
              <InputLabel>Voice</InputLabel>
              <Select
                value={ttsVoice}
                label="Voice"
                onChange={(e) => setTtsVoice(e.target.value)}
              >
                <MenuItem value="">
                  <em>Default</em>
                </MenuItem>
                {voices.map((voice) => (
                  <MenuItem key={voice} value={voice}>
                    {voice}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>

          {/* TTS Language */}
          <Box sx={{ mb: 3 }}>
            <TextField
              label="Language Code"
              value={ttsLanguage}
              onChange={(e) => setTtsLanguage(e.target.value)}
              fullWidth
              helperText='Language code (e.g., "en", "ja", "zh")'
            />
          </Box>

          {/* TTS Auto-Play */}
          <Box sx={{ mb: 4 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={ttsAutoPlay}
                  onChange={(e) => setTtsAutoPlay(e.target.checked)}
                />
              }
              label="Auto-play assistant messages"
            />
          </Box>

          {/* INDEX-TTS Emotion Controls - Only show when backend is index-tts */}
          {ttsBackend === 'index-tts' && (
            <>
              <Divider sx={{ mb: 3 }} />
              <Typography variant="h6" sx={{ mb: 3 }}>
                Emotion Controls (INDEX-TTS)
              </Typography>

              {/* Emotion Reference Audio */}
              <Box sx={{ mb: 3 }}>
                <FormControl fullWidth>
                  <InputLabel>Emotion Reference Audio</InputLabel>
                  <Select
                    value={ttsEmotionAudio}
                    label="Emotion Reference Audio"
                    onChange={(e) => setTtsEmotionAudio(e.target.value)}
                  >
                    <MenuItem value="">
                      <em>None</em>
                    </MenuItem>
                    {voices.map((voice) => (
                      <MenuItem key={voice} value={voice}>
                        {voice}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Box>

              {/* Emotion Strength (Alpha) */}
              <Box sx={{ mb: 3 }}>
                <Typography gutterBottom>
                  Emotion Strength: {ttsEmotionAlpha.toFixed(1)}
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <Typography variant="body2" sx={{ minWidth: 30 }}>
                    0.0
                  </Typography>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={ttsEmotionAlpha}
                    onChange={(e) => setTtsEmotionAlpha(parseFloat(e.target.value))}
                    style={{ flex: 1 }}
                  />
                  <Typography variant="body2" sx={{ minWidth: 30 }}>
                    1.0
                  </Typography>
                </Box>
              </Box>

              {/* Use Emotion from Text */}
              <Box sx={{ mb: 4 }}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={ttsUseEmotionText}
                      onChange={(e) => setTtsUseEmotionText(e.target.checked)}
                    />
                  }
                  label="Infer emotion from text content"
                />
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                  When enabled, the model will analyze the text to determine emotional tone
                </Typography>
              </Box>
            </>
          )}

          {/* Save TTS Settings Button */}
          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              variant="contained"
              startIcon={<SaveIcon />}
              onClick={handleSaveTTSSettings}
            >
              Save TTS Settings
            </Button>
          </Box>
        </MotionPaper>
        )}
      </Box>
    </Box>
  );
};
