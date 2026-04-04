import React, { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  FormControlLabel,
  Switch,
  Divider,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Button,
  SelectChangeEvent,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import { useTTS } from '../../hooks/useTTS';
import { storage } from '../../utils/storage';
import { apiClient } from '../../api/client';
import { useMicStore } from '../../store/micStore';

interface ModelEntry {
  id: string;
  name: string;
}

const COMMON_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ko', label: 'Korean' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'es', label: 'Spanish' },
  { code: 'ru', label: 'Russian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'th', label: 'Thai' },
  { code: 'ar', label: 'Arabic' },
];

export const TTSSection: React.FC = () => {
  const { backends, loadBackends } = useTTS();

  // ASR settings
  const [micDevices, setMicDevices] = useState<Array<{ deviceId: string; label: string }>>([]);
  const [selectedMicId, setSelectedMicIdState] = useState(storage.getASRDeviceId() || '');
  const [alwaysListen, setAlwaysListenState] = useState(storage.getASRAlwaysListen());
  const [asrMode, setAsrModeState] = useState(storage.getASRMode());
  const [asrLanguage, setAsrLanguageState] = useState(storage.getASRLanguage() || '');
  const [asrFixedModel, setAsrFixedModelState] = useState(storage.getASRFixedModel());
  const [modelMap, setModelMapState] = useState(storage.getASRModelMap());
  const [availableModels, setAvailableModels] = useState<ModelEntry[]>([]);

  const setAlwaysListen = (v: boolean) => {
    setAlwaysListenState(v);
    storage.setASRAlwaysListen(v);
    const mic = useMicStore.getState();
    if (v && mic.status === 'idle') {
      mic.startListening();
    } else if (!v && mic.status !== 'idle') {
      mic.stopListening();
    }
  };

  const setAsrMode = (v: 'fixed' | 'routing') => {
    setAsrModeState(v);
    storage.setASRMode(v);
  };

  const setAsrLanguage = (v: string) => {
    setAsrLanguageState(v);
    if (v) storage.setASRLanguage(v);
    else storage.clearASRLanguage();
  };

  const setAsrFixedModel = (v: string) => {
    setAsrFixedModelState(v);
    storage.setASRFixedModel(v);
  };


  const setModelMap = (map: Array<{ language: string; model: string }>) => {
    setModelMapState(map);
    storage.setASRModelMap(map);
  };

  // TTS settings
  const [ttsBackend, setTtsBackendState] = useState(storage.getTTSBackend() || 'vixtts');
  const [ttsAutoPlay, setTtsAutoPlayState] = useState(storage.getTTSAutoPlay());
  const [ttsEmotionAlpha, setTtsEmotionAlphaState] = useState(storage.getTTSEmotionAlpha());
  const [ttsUseEmotionText, setTtsUseEmotionTextState] = useState(storage.getTTSUseEmotionText());

  const setTtsBackend = (v: string) => { setTtsBackendState(v); storage.setTTSBackend(v); };
  const setTtsAutoPlay = (v: boolean) => { setTtsAutoPlayState(v); storage.setTTSAutoPlay(v); };
  const setTtsEmotionAlpha = (v: number) => { setTtsEmotionAlphaState(v); storage.setTTSEmotionAlpha(v); };
  const setTtsUseEmotionText = (v: boolean) => { setTtsUseEmotionTextState(v); storage.setTTSUseEmotionText(v); };

  const setSelectedMicId = (deviceId: string) => {
    setSelectedMicIdState(deviceId);
    if (deviceId) {
      storage.setASRDeviceId(deviceId);
      useMicStore.getState().selectDevice(deviceId);
    }
  };

  useEffect(() => {
    loadBackends();
    apiClient.getASRModels()
      .then((models) => setAvailableModels(models.map((m) => ({ id: m.id, name: m.name }))))
      .catch(() => {});
    // Load mic devices
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach((t) => t.stop());
        return navigator.mediaDevices.enumerateDevices();
      })
      .then((devices) => {
        setMicDevices(
          devices
            .filter((d) => d.kind === 'audioinput')
            .map((d) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${d.deviceId.slice(0, 8)}` }))
        );
      })
      .catch(() => {});
  }, [loadBackends]);

  const addMapping = () => {
    setModelMap([...modelMap, { language: '', model: '' }]);
  };

  const updateMapping = (index: number, field: 'language' | 'model', value: string) => {
    const updated = [...modelMap];
    updated[index] = { ...updated[index], [field]: value };
    setModelMap(updated);
  };

  const removeMapping = (index: number) => {
    setModelMap(modelMap.filter((_entry, i) => i !== index));
  };

  return (
    <Box sx={{ maxWidth: 700 }}>
      <Typography variant="h3" sx={{ mb: 3 }}>TTS & ASR</Typography>

      {/* Always Listen */}
      <Box sx={{ mb: 3 }}>
        <FormControlLabel
          control={
            <Switch
              checked={alwaysListen}
              onChange={(e) => setAlwaysListen(e.target.checked)}
            />
          }
          label="Always listen"
        />
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          Keep microphone active to detect trigger words or push-to-talk (Ctrl+Space). Disable to save resources.
        </Typography>
      </Box>

      {/* Microphone Selection */}
      <Box sx={{ mb: 3 }}>
        <FormControl fullWidth size="small">
          <InputLabel>Microphone</InputLabel>
          <Select
            value={selectedMicId}
            label="Microphone"
            onChange={(e: SelectChangeEvent) => setSelectedMicId(e.target.value)}
          >
            <MenuItem value="">
              <em>Default</em>
            </MenuItem>
            {micDevices.map((d) => (
              <MenuItem key={d.deviceId} value={d.deviceId}>
                {d.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>

      {/* ASR Mode */}
      <Box sx={{ mb: 3 }}>
        <FormControl fullWidth size="small">
          <InputLabel>ASR Mode</InputLabel>
          <Select
            value={asrMode}
            label="ASR Mode"
            onChange={(e: SelectChangeEvent) => setAsrMode(e.target.value as 'fixed' | 'routing')}
          >
            <MenuItem value="fixed">Fixed model</MenuItem>
            <MenuItem value="routing">Auto routing</MenuItem>
          </Select>
        </FormControl>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          {asrMode === 'fixed'
            ? 'Use one model for all transcription.'
            : 'Detect language first, then route to the best model for that language.'}
        </Typography>
      </Box>

      {/* Fixed model settings */}
      {asrMode === 'fixed' && (
        <Box sx={{ mb: 3 }}>
          <FormControl fullWidth size="small">
            <InputLabel>Model</InputLabel>
            <Select
              value={asrFixedModel}
              label="Model"
              onChange={(e: SelectChangeEvent) => setAsrFixedModel(e.target.value)}
            >
              <MenuItem value="">
                <em>Default (server)</em>
              </MenuItem>
              {availableModels.map((m) => (
                <MenuItem key={m.id} value={m.name}>
                  {m.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>
      )}

      {/* Auto routing settings */}
      {asrMode === 'routing' && (
        <Box sx={{ mb: 3 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Language → Model Mapping
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
            Each language routes to a specific model. Unmatched languages use the server default.
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Language</TableCell>
                <TableCell>Model</TableCell>
                <TableCell width={48}></TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {modelMap.map((entry, i) => (
                <TableRow key={i}>
                  <TableCell sx={{ py: 0.5 }}>
                    <FormControl fullWidth size="small" variant="standard">
                      <Select
                        value={entry.language}
                        onChange={(e) => updateMapping(i, 'language', e.target.value)}
                        displayEmpty
                      >
                        <MenuItem value="">
                          <em>Select...</em>
                        </MenuItem>
                        {COMMON_LANGUAGES.map((lang) => (
                          <MenuItem key={lang.code} value={lang.code}>
                            {lang.label} ({lang.code})
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </TableCell>
                  <TableCell sx={{ py: 0.5 }}>
                    <FormControl fullWidth size="small" variant="standard">
                      <Select
                        value={entry.model}
                        onChange={(e) => updateMapping(i, 'model', e.target.value)}
                        displayEmpty
                      >
                        <MenuItem value="">
                          <em>Default</em>
                        </MenuItem>
                        {availableModels.map((m) => (
                          <MenuItem key={m.id} value={m.name}>
                            {m.name}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </TableCell>
                  <TableCell sx={{ py: 0.5 }}>
                    <IconButton size="small" onClick={() => removeMapping(i)}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
              {modelMap.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} sx={{ color: 'text.secondary', textAlign: 'center' }}>
                    No mappings configured.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <Button
            size="small"
            startIcon={<AddIcon />}
            onClick={addMapping}
            sx={{ mt: 1 }}
          >
            Add mapping
          </Button>
        </Box>
      )}

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
