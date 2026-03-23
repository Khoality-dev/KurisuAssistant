import React, { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  Alert,
} from '@mui/material';
import { Save as SaveIcon } from '@mui/icons-material';
import { useAuthStore } from '../../store/authStore';
import { apiClient } from '../../api/client';
import { ModelPicker } from '../ModelPicker';
import type { UserProfile } from '../../api/types';

export const AccountSection: React.FC = () => {
  const { user, loadUserProfile } = useAuthStore();

  const [ollamaUrl, setOllamaUrl] = useState('');
  const [summaryModel, setSummaryModel] = useState('');
  const [contextSize, setContextSize] = useState<number | ''>('');
  const [models, setModels] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    if (user) {
      setOllamaUrl(user.ollama_url || '');
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

  useEffect(() => {
    loadModels();
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    setSuccessMessage('');
    setErrorMessage('');

    try {
      const profileUpdates: Partial<UserProfile> = {};
      profileUpdates.ollama_url = ollamaUrl || '';
      profileUpdates.summary_model = summaryModel.trim() || '';
      profileUpdates.context_size = contextSize || 0;

      if (Object.keys(profileUpdates).length > 0) {
        await apiClient.updateUserProfile(profileUpdates);
      }

      await loadUserProfile();

      setSuccessMessage('Settings saved successfully!');
      setTimeout(() => setSuccessMessage(''), 3000);
    } catch (error: any) {
      console.error('Failed to save account settings:', error);
      setErrorMessage(error.message || 'Failed to save account settings');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Box sx={{ maxWidth: 700 }}>
      <Typography variant="h3" sx={{ mb: 3 }}>Account</Typography>

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

      {/* Save Button */}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          variant="contained"
          startIcon={<SaveIcon />}
          onClick={handleSave}
          disabled={isSaving}
        >
          {isSaving ? 'Saving...' : 'Save Account Settings'}
        </Button>
      </Box>
    </Box>
  );
};
