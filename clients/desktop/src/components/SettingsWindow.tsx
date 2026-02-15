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
import { useTTS } from '../hooks/useTTS';
import { storage } from '../utils/storage';
import type { UserProfile } from '../api/types';

const MotionPaper = motion(Paper);

interface SettingsWindowProps {
  onBack: () => void;
}

export const SettingsWindow: React.FC<SettingsWindowProps> = ({ onBack }) => {
  const { user, loadUserProfile } = useAuthStore();
  const { voices, loadVoices, backends, loadBackends } = useTTS();

  const [currentTab, setCurrentTab] = useState(0);

  const [preferredName, setPreferredName] = useState('');
  const [ollamaUrl, setOllamaUrl] = useState('');
  const [summaryModel, setSummaryModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [userAvatarFile, setUserAvatarFile] = useState<File | null>(null);
  const [userAvatarPreview, setUserAvatarPreview] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  // TTS settings — auto-saved to localStorage on change
  const [ttsBackend, setTtsBackendState] = useState(storage.getTTSBackend() || 'gpt-sovits');
  const [ttsAutoPlay, setTtsAutoPlayState] = useState(storage.getTTSAutoPlay());

  // INDEX-TTS emotion settings
  const [ttsEmotionAudio, setTtsEmotionAudioState] = useState(storage.getTTSEmotionAudio() || '');
  const [ttsEmotionAlpha, setTtsEmotionAlphaState] = useState(storage.getTTSEmotionAlpha());
  const [ttsUseEmotionText, setTtsUseEmotionTextState] = useState(storage.getTTSUseEmotionText());

  // Auto-save wrappers
  const setTtsBackend = (v: string) => { setTtsBackendState(v); storage.setTTSBackend(v); };
  const setTtsAutoPlay = (v: boolean) => { setTtsAutoPlayState(v); storage.setTTSAutoPlay(v); };
  const setTtsEmotionAudio = (v: string) => { setTtsEmotionAudioState(v); storage.setTTSEmotionAudio(v); };
  const setTtsEmotionAlpha = (v: number) => { setTtsEmotionAlphaState(v); storage.setTTSEmotionAlpha(v); };
  const setTtsUseEmotionText = (v: boolean) => { setTtsUseEmotionTextState(v); storage.setTTSUseEmotionText(v); };

  const userAvatarInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (user) {
      setPreferredName(user.preferred_name || '');
      setOllamaUrl(user.ollama_url || '');
      setSummaryModel(user.summary_model || '');

      if (user.user_avatar_uuid) {
        setUserAvatarPreview(apiClient.getImageUrl(user.user_avatar_uuid));
      }
    }
  }, [user]);

  // Load TTS voices, backends, and models on mount
  useEffect(() => {
    loadVoices();
    loadBackends();
    apiClient.getModels().then(setModels).catch(() => {});
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

  const handleSaveAccountSettings = async () => {
    setIsSaving(true);
    setSuccessMessage('');
    setErrorMessage('');

    try {
      // Update text fields (JSON request - PATCH /users/me)
      const profileUpdates: Partial<UserProfile> = {};
      if (preferredName !== undefined && preferredName !== '') {
        profileUpdates.preferred_name = preferredName;
      }
      // Always include ollama_url (empty string will clear it on backend)
      profileUpdates.ollama_url = ollamaUrl || '';
      profileUpdates.summary_model = summaryModel || '';

      if (Object.keys(profileUpdates).length > 0) {
        await apiClient.updateUserProfile(profileUpdates);
      }

      // Update avatar (multipart request - PATCH /users/me/avatars)
      if (userAvatarFile) {
        await apiClient.updateUserAvatars(userAvatarFile, undefined);
      }

      await loadUserProfile(); // Reload user profile to get updated data

      setSuccessMessage('Settings saved successfully!');
      setUserAvatarFile(null);

      // Clear success message after 3 seconds
      setTimeout(() => setSuccessMessage(''), 3000);
    } catch (error: any) {
      console.error('Failed to save account settings:', error);
      setErrorMessage(error.message || 'Failed to save account settings');
    } finally {
      setIsSaving(false);
    }
  };

  // TTS settings are now auto-saved on change — no manual save needed

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

          {/* Ollama Server URL */}
          <Box sx={{ mb: 4 }}>
            <TextField
              label="Ollama Server URL"
              value={ollamaUrl}
              onChange={(e) => setOllamaUrl(e.target.value)}
              fullWidth
              placeholder="http://localhost:11434"
              helperText="Leave empty to use the default server"
            />
          </Box>

          {/* Summary Model */}
          <Box sx={{ mb: 4 }}>
            <FormControl fullWidth>
              <InputLabel>Summary Model</InputLabel>
              <Select
                value={summaryModel}
                label="Summary Model"
                onChange={(e) => setSummaryModel(e.target.value)}
              >
                <MenuItem value="">
                  <em>Use chat model</em>
                </MenuItem>
                {models.map((model) => (
                  <MenuItem key={model} value={model}>
                    {model}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
              Model used to generate session summaries. Leave empty to use the active chat model.
            </Typography>
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

          {/* TTS settings are auto-saved on change */}
        </MotionPaper>
        )}
      </Box>
    </Box>
  );
};
