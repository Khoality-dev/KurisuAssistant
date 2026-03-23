import React, { useState, useEffect } from 'react';
import {
  Box,
  Paper,
  Typography,
  TextField,
  Button,
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
import { ModelPicker } from './ModelPicker';

const MotionPaper = motion(Paper);

interface SettingsWindowProps {
  onBack: () => void;
}

export const SettingsWindow: React.FC<SettingsWindowProps> = ({ onBack }) => {
  const { user, loadUserProfile } = useAuthStore();
  const { backends, loadBackends } = useTTS();

  const [currentTab, setCurrentTab] = useState(0);

  const [ollamaUrl, setOllamaUrl] = useState('');
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [summaryModel, setSummaryModel] = useState('');
  const [contextSize, setContextSize] = useState<number | ''>('');
  const [models, setModels] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  // ASR settings — auto-saved to localStorage on change
  const [asrLanguage, setAsrLanguageState] = useState(storage.getASRLanguage() || '');
  const setAsrLanguage = (v: string) => {
    setAsrLanguageState(v);
    if (v) storage.setASRLanguage(v);
    else storage.clearASRLanguage();
  };

  // TTS settings — auto-saved to localStorage on change
  const [ttsBackend, setTtsBackendState] = useState(storage.getTTSBackend() || 'vixtts');
  const [ttsAutoPlay, setTtsAutoPlayState] = useState(storage.getTTSAutoPlay());

  // viXTTS emotion settings
  const [ttsEmotionAlpha, setTtsEmotionAlphaState] = useState(storage.getTTSEmotionAlpha());
  const [ttsUseEmotionText, setTtsUseEmotionTextState] = useState(storage.getTTSUseEmotionText());

  // Auto-save wrappers
  const setTtsBackend = (v: string) => { setTtsBackendState(v); storage.setTTSBackend(v); };
  const setTtsAutoPlay = (v: boolean) => { setTtsAutoPlayState(v); storage.setTTSAutoPlay(v); };
  const setTtsEmotionAlpha = (v: number) => { setTtsEmotionAlphaState(v); storage.setTTSEmotionAlpha(v); };
  const setTtsUseEmotionText = (v: boolean) => { setTtsUseEmotionTextState(v); storage.setTTSUseEmotionText(v); };

  useEffect(() => {
    if (user) {
      setOllamaUrl(user.ollama_url || '');
      setGeminiApiKey(''); // Don't prefill — API returns masked value
      setSummaryModel(user.summary_model || '');
      setContextSize(user.context_size || '');
    }
  }, [user]);

  const loadModels = async () => {
    try {
      const data = await apiClient.getModels();
      setModels(data);
    } catch (error: any) {
      console.error('Failed to load models:', error);
      setErrorMessage(error.response?.data?.detail || error.message || 'Failed to load models from Ollama');
    }
  };

  // Load TTS backends and models on mount
  useEffect(() => {
    loadBackends();
    loadModels();
  }, [loadBackends]);

  const handleSaveAccountSettings = async () => {
    setIsSaving(true);
    setSuccessMessage('');
    setErrorMessage('');

    try {
      // Update text fields (JSON request - PATCH /users/me)
      const profileUpdates: Partial<UserProfile> = {};
      // Always include ollama_url (empty string will clear it on backend)
      profileUpdates.ollama_url = ollamaUrl || '';
      if (geminiApiKey) profileUpdates.gemini_api_key = geminiApiKey;
      profileUpdates.summary_model = summaryModel.trim() || '';
      profileUpdates.context_size = contextSize || 0;

      if (Object.keys(profileUpdates).length > 0) {
        await apiClient.updateUserProfile(profileUpdates);
      }

      await loadUserProfile(); // Reload user profile to get updated data

      setSuccessMessage('Settings saved successfully!');

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

          {/* Gemini API Key */}
          <Box sx={{ mb: 4 }}>
            <TextField
              label="Google Gemini API Key"
              value={geminiApiKey}
              onChange={(e) => setGeminiApiKey(e.target.value)}
              fullWidth
              type="password"
              placeholder={user?.gemini_api_key ? '••••••••' + user.gemini_api_key.slice(-4) : 'Enter API key to enable Gemini models'}
              helperText="Get your key from ai.google.dev. Gemini models will appear in the model picker."
            />
          </Box>

          {/* Summary Model */}
          <Box sx={{ mb: 4 }}>
            <ModelPicker
              label="Summary Model"
              value={summaryModel}
              models={models}
              onChange={setSummaryModel}
              onRefresh={loadModels}
              onSuccess={(message) => {
                setSuccessMessage(message);
                setTimeout(() => setSuccessMessage(''), 3000);
              }}
              onError={setErrorMessage}
            />
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
              Model used for session summaries and agent memory consolidation. Summaries are disabled until a model is selected.
            </Typography>
          </Box>

          {/* Context Size */}
          <Box sx={{ mb: 4 }}>
            <TextField
              label="Context Size"
              type="number"
              value={contextSize}
              onChange={(e) => setContextSize(e.target.value ? parseInt(e.target.value, 10) : '')}
              fullWidth
              placeholder="8192"
              helperText="Ollama context window size (num_ctx). Higher values use more VRAM. Default: 8192."
              inputProps={{ min: 2048, max: 131072, step: 1024 }}
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

          {/* ASR Language */}
          <Box sx={{ mb: 3 }}>
            <TextField
              label="ASR Language"
              value={asrLanguage}
              onChange={(e) => setAsrLanguage(e.target.value)}
              fullWidth
              placeholder="Auto-detect"
              helperText="ISO 639-1 code (en, ja, zh, vi). Empty = auto-detect from first transcription."
            />
          </Box>

          <Divider sx={{ mb: 3 }} />

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

          <Box sx={{ mb: 3 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={ttsAutoPlay}
                  onChange={(e) => setTtsAutoPlay(e.target.checked)}
                />
              }
              label="Generate TTS During Responses"
            />
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              When enabled, agent replies are spoken while the response text is still streaming.
            </Typography>
          </Box>

          {/* viXTTS emotion controls */}
          {ttsBackend === 'vixtts' && (
            <>
              <Divider sx={{ mb: 3 }} />
              <Typography variant="h6" sx={{ mb: 3 }}>
                Emotion Controls (viXTTS)
              </Typography>

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
