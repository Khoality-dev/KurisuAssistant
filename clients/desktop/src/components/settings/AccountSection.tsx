import React, { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  Alert,
  Chip,
  CircularProgress,
} from '@mui/material';
import {
  Save as SaveIcon,
  Visibility as ShowIcon,
  VisibilityOff as HideIcon,
} from '@mui/icons-material';
import { useAuthStore } from '../../store/authStore';
import { apiClient } from '../../api/client';
import { ModelPicker } from '../ModelPicker';
import type { UserProfile } from '../../api/types';

const ApiKeyField: React.FC<{
  label: string;
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  onToggleShow: () => void;
  valid: boolean | null;
  validating: boolean;
  onValidate: () => void;
  helperText: string;
}> = ({ label, value, onChange, show, onToggleShow, valid, validating, onValidate, helperText }) => (
  <Box sx={{ mb: 4 }}>
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
      <TextField
        label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        fullWidth
        type={show ? 'text' : 'password'}
        placeholder="Enter API key"
        helperText={helperText}
        InputProps={{
          endAdornment: value ? (
            <Box sx={{ display: 'flex', gap: 0.5, mr: -0.5 }}>
              <Button size="small" onClick={onToggleShow} sx={{ minWidth: 0, p: 0.5 }}>
                {show ? <HideIcon fontSize="small" /> : <ShowIcon fontSize="small" />}
              </Button>
            </Box>
          ) : undefined,
        }}
      />
      <Button
        variant="outlined"
        size="small"
        onClick={onValidate}
        disabled={!value || validating}
        sx={{ mt: 1, minWidth: 80, whiteSpace: 'nowrap' }}
      >
        {validating ? <CircularProgress size={16} /> : 'Validate'}
      </Button>
    </Box>
    {valid === true && <Chip label="Valid" size="small" color="success" sx={{ mt: 1 }} />}
    {valid === false && <Chip label="Invalid" size="small" color="error" sx={{ mt: 1 }} />}
  </Box>
);

export const AccountSection: React.FC = () => {
  const { user, loadUserProfile } = useAuthStore();

  const [ollamaUrl, setOllamaUrl] = useState('');
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [nvidiaApiKey, setNvidiaApiKey] = useState('');
  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [showNvidiaKey, setShowNvidiaKey] = useState(false);
  const [geminiValid, setGeminiValid] = useState<boolean | null>(null);
  const [nvidiaValid, setNvidiaValid] = useState<boolean | null>(null);
  const [validating, setValidating] = useState('');
  const [summaryModel, setSummaryModel] = useState('');
  const [contextSize, setContextSize] = useState<number | ''>('');
  const [models, setModels] = useState<Array<{ name: string; provider: string }>>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    if (user) {
      setOllamaUrl(user.ollama_url || '');
      setGeminiApiKey(user.gemini_api_key || '');
      setNvidiaApiKey(user.nvidia_api_key || '');
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
      profileUpdates.gemini_api_key = geminiApiKey || '';
      profileUpdates.nvidia_api_key = nvidiaApiKey || '';
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

      {/* Gemini API Key */}
      <ApiKeyField
        label="Google Gemini API Key"
        value={geminiApiKey}
        onChange={setGeminiApiKey}
        show={showGeminiKey}
        onToggleShow={() => setShowGeminiKey(!showGeminiKey)}
        valid={geminiValid}
        validating={validating === 'gemini'}
        onValidate={async () => {
          if (!geminiApiKey) return;
          setValidating('gemini');
          setGeminiValid(null);
          try {
            const result = await apiClient.validateApiKey('gemini', geminiApiKey);
            setGeminiValid(result.valid);
          } catch { setGeminiValid(false); }
          setValidating('');
        }}
        helperText="Get your key from ai.google.dev"
      />

      {/* NVIDIA NIM API Key */}
      <ApiKeyField
        label="NVIDIA NIM API Key"
        value={nvidiaApiKey}
        onChange={setNvidiaApiKey}
        show={showNvidiaKey}
        onToggleShow={() => setShowNvidiaKey(!showNvidiaKey)}
        valid={nvidiaValid}
        validating={validating === 'nvidia'}
        onValidate={async () => {
          if (!nvidiaApiKey) return;
          setValidating('nvidia');
          setNvidiaValid(null);
          try {
            const result = await apiClient.validateApiKey('nvidia', nvidiaApiKey);
            setNvidiaValid(result.valid);
          } catch { setNvidiaValid(false); }
          setValidating('');
        }}
        helperText="Get your key from build.nvidia.com"
      />

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
