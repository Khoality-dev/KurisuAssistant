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
  SelectChangeEvent,
} from '@mui/material';
import { storage } from '../../utils/storage';
import { useMicStore } from '../../store/micStore';

interface AudioDevice {
  deviceId: string;
  label: string;
}

export const VoiceSection: React.FC = () => {
  const [micDevices, setMicDevices] = useState<AudioDevice[]>([]);
  const [speakerDevices, setSpeakerDevices] = useState<AudioDevice[]>([]);
  const [selectedMicId, setSelectedMicIdState] = useState(storage.getASRDeviceId() || '');
  const [selectedSpeakerId, setSelectedSpeakerIdState] = useState(
    localStorage.getItem('kurisu_speaker_device_id') || ''
  );
  const [alwaysListen, setAlwaysListenState] = useState(storage.getASRAlwaysListen());

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

  const setSelectedMicId = (deviceId: string) => {
    setSelectedMicIdState(deviceId);
    if (deviceId) {
      storage.setASRDeviceId(deviceId);
      useMicStore.getState().selectDevice(deviceId);
    }
  };

  const setSelectedSpeakerId = (deviceId: string) => {
    setSelectedSpeakerIdState(deviceId);
    localStorage.setItem('kurisu_speaker_device_id', deviceId);
  };

  // Pause listening while on this page to free the mic for device enumeration
  useEffect(() => {
    const mic = useMicStore.getState();
    const wasListening = mic.status !== 'idle';
    if (wasListening) mic.stopListening();
    return () => {
      // Restart if always-listen is enabled
      if (storage.getASRAlwaysListen()) {
        useMicStore.getState().startListening();
      }
    };
  }, []);

  useEffect(() => {
    const loadDevices = async () => {
      // Request mic permission to get device labels
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        // Permission may already be granted or denied
      }
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        setMicDevices(
          devices
            .filter((d) => d.kind === 'audioinput')
            .map((d) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${d.deviceId.slice(0, 8)}` }))
        );
        setSpeakerDevices(
          devices
            .filter((d) => d.kind === 'audiooutput')
            .map((d) => ({ deviceId: d.deviceId, label: d.label || `Speaker ${d.deviceId.slice(0, 8)}` }))
        );
      } catch (err) {
        console.error('Failed to enumerate devices:', err);
      }
    };
    loadDevices();
  }, []);

  return (
    <Box sx={{ maxWidth: 700 }}>
      <Typography variant="h3" sx={{ mb: 3 }}>Voice</Typography>

      {/* Microphone */}
      <Typography variant="h6" sx={{ mb: 2 }}>Microphone</Typography>

      <Box sx={{ mb: 3 }}>
        <FormControl fullWidth size="small">
          <InputLabel>Input device</InputLabel>
          <Select
            value={selectedMicId}
            label="Input device"
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
          Keep microphone active to detect trigger words or push-to-talk (Ctrl+Space).
        </Typography>
      </Box>

      <Divider sx={{ mb: 3 }} />

      {/* Speaker */}
      <Typography variant="h6" sx={{ mb: 2 }}>Speaker</Typography>

      <Box sx={{ mb: 3 }}>
        <FormControl fullWidth size="small">
          <InputLabel>Output device</InputLabel>
          <Select
            value={selectedSpeakerId}
            label="Output device"
            onChange={(e: SelectChangeEvent) => setSelectedSpeakerId(e.target.value)}
          >
            <MenuItem value="">
              <em>Default</em>
            </MenuItem>
            {speakerDevices.map((d) => (
              <MenuItem key={d.deviceId} value={d.deviceId}>
                {d.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>
    </Box>
  );
};
