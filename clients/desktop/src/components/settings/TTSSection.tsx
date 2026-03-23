import React, { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  FormControlLabel,
  Switch,
  Divider,
} from '@mui/material';
import { useTTS } from '../../hooks/useTTS';
import { storage } from '../../utils/storage';

export const TTSSection: React.FC = () => {
  const { backends, loadBackends } = useTTS();

  // ASR settings -- auto-saved to localStorage on change
  const [asrLanguage, setAsrLanguageState] = useState(storage.getASRLanguage() || '');
  const setAsrLanguage = (v: string) => {
    setAsrLanguageState(v);
    if (v) storage.setASRLanguage(v);
    else storage.clearASRLanguage();
  };

  // TTS settings -- auto-saved to localStorage on change
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
    loadBackends();
  }, [loadBackends]);

  return (
    <Box sx={{ maxWidth: 700 }}>
      <Typography variant="h3" sx={{ mb: 3 }}>TTS & ASR</Typography>

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
    </Box>
  );
};
