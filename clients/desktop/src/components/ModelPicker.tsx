import React, { useMemo, useState } from 'react';
import {
  Autocomplete,
  Box,
  Button,
  Chip,
  IconButton,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { CircularProgress } from '@mui/material';
import {
  GetApp as GetAppIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import { apiClient } from '../api/client';

interface ModelPickerProps {
  label: string;
  value: string;
  models: Array<{ name: string; provider: string }>;
  onChange: (value: string) => void;
  onRefresh: () => Promise<void>;
  onSuccess?: (message: string) => void;
  onError?: (message: string) => void;
  helperText?: string;
  required?: boolean;
  disabled?: boolean;
}

const refreshIconSx = {
  animation: 'spin 1s linear infinite',
  '@keyframes spin': {
    '0%': { transform: 'rotate(0deg)' },
    '100%': { transform: 'rotate(360deg)' },
  },
};

export const ModelPicker: React.FC<ModelPickerProps> = ({
  label,
  value,
  models,
  onChange,
  onRefresh,
  onSuccess,
  onError,
  helperText,
  required = false,
  disabled = false,
}) => {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isPulling, setIsPulling] = useState(false);

  const providerMap = useMemo(() => {
    const map = new Map<string, string>();
    models.forEach(m => map.set(m.name, m.provider));
    return map;
  }, [models]);

  const sortedModelNames = useMemo(
    () => [...models].sort((a, b) => a.name.localeCompare(b.name)).map(m => m.name),
    [models]
  );

  const trimmedValue = value.trim();
  const installedModel = trimmedValue
    ? sortedModelNames.find((model) => model.toLowerCase() === trimmedValue.toLowerCase())
    : undefined;

  const handleRefresh = async () => {
    try {
      setIsRefreshing(true);
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  };

  const handlePull = async () => {
    if (!trimmedValue || installedModel) {
      return;
    }

    try {
      setIsPulling(true);
      const result = await apiClient.pullModel(trimmedValue);
      onChange(trimmedValue);
      await onRefresh();
      onSuccess?.(result.message);
    } catch (error: any) {
      onError?.(
        error.response?.data?.detail ||
        error.message ||
        `Failed to pull model "${trimmedValue}"`
      );
    } finally {
      setIsPulling(false);
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
        <Autocomplete
          freeSolo
          options={sortedModelNames}
          value={value === '' ? null : value}
          inputValue={value}
          onChange={(_, newValue) => onChange(typeof newValue === 'string' ? newValue : '')}
          onInputChange={(_, newInputValue, reason) => {
            if (reason === 'input' || reason === 'clear') {
              onChange(newInputValue);
            }
          }}
          filterOptions={(options, state) => {
            const input = state.inputValue.trim().toLowerCase();
            if (!input) {
              return options;
            }
            return options.filter((option) => option.toLowerCase().includes(input));
          }}
          selectOnFocus
          handleHomeEndKeys
          clearOnBlur={false}
          noOptionsText="No installed models match. Enter an exact model name and click Pull."
          disabled={disabled || isPulling}
          sx={{ flex: 1 }}
          renderOption={(props, option) => {
            const provider = (providerMap.get(option) || 'ollama').charAt(0).toUpperCase() + (providerMap.get(option) || 'ollama').slice(1);
            return (
              <li {...props} key={option}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                  <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
                    {option}
                  </Typography>
                  <Chip
                    label={provider}
                    size="small"
                    variant="outlined"
                    sx={{
                      ml: 1,
                      height: 20,
                      fontSize: '0.65rem',
                      fontWeight: 600,
                      flexShrink: 0,
                      borderColor: provider.toLowerCase() === 'gemini' ? '#4285F4' : '#888',
                      color: provider.toLowerCase() === 'gemini' ? '#4285F4' : '#888',
                    }}
                  />
                </Box>
              </li>
            );
          }}
          renderInput={(params) => (
            <TextField
              {...params}
              label={label}
              required={required}
              placeholder="e.g. llama3.2:latest or gemini-2.0-flash"
              helperText={
                helperText ||
                'Shows available models from Ollama and Gemini. Enter a model name to pull from Ollama.'
              }
            />
          )}
        />
        <Tooltip title="Refresh model list">
          <span>
            <IconButton
              onClick={handleRefresh}
              disabled={disabled || isRefreshing || isPulling}
              sx={{ mt: 1 }}
            >
              <RefreshIcon sx={isRefreshing ? refreshIconSx : undefined} />
            </IconButton>
          </span>
        </Tooltip>
      </Box>
      <Box
        sx={{
          mt: 1,
          display: 'flex',
          justifyContent: 'flex-end',
          flexWrap: 'wrap',
          gap: 1,
        }}
      >
        {!installedModel && trimmedValue && (
          <Button
            variant="contained"
            size="small"
            startIcon={isPulling ? <CircularProgress size={16} /> : <GetAppIcon />}
            onClick={handlePull}
            disabled={disabled || isPulling}
            sx={{ px: 1.5, py: 0.75, minWidth: 116 }}
          >
            {isPulling ? 'Pulling...' : 'Pull Model'}
          </Button>
        )}
      </Box>
    </Box>
  );
};
