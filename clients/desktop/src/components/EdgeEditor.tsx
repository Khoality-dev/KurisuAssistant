import React, { useState, useRef, useEffect } from 'react';
import {
  Box,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  IconButton,
  Alert,
  CircularProgress,
  TextField,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
  Slider,
} from '@mui/material';
import {
  CloudUpload as CloudUploadIcon,
  Close as CloseIcon,
  Delete as DeleteIcon,
  Add as AddIcon,
} from '@mui/icons-material';
import { apiClient } from '../api/client';
import { config } from '../config';
import type { AnimationEdge, TransitionCondition } from '../videocall/types';

export interface EdgeEditorProps {
  open: boolean;
  agentId: number;
  edge: AnimationEdge;
  fromNodeName: string;
  toNodeName: string;
  onSave: (updatedEdge: AnimationEdge) => void;
  onDelete: () => void;
  onClose: () => void;
}

interface VideoEntry {
  url: string;         // Server URL (empty string if not uploaded yet)
  pendingFile?: File;  // Local file awaiting upload
  previewSrc: string;  // Display URL (blob: for local, resolved server URL for existing)
}

export const EdgeEditor: React.FC<EdgeEditorProps> = ({
  open,
  agentId,
  edge,
  fromNodeName,
  toNodeName,
  onSave,
  onDelete,
  onClose,
}) => {
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [videos, setVideos] = useState<VideoEntry[]>([]);
  const [conditionType, setConditionType] = useState<string>(edge.condition?.type || 'random');
  const [minInterval, setMinInterval] = useState<number>(
    edge.condition?.type === 'random' ? edge.condition.min_interval_ms / 1000 : 5
  );
  const [maxInterval, setMaxInterval] = useState<number>(
    edge.condition?.type === 'random' ? edge.condition.max_interval_ms / 1000 : 15
  );
  const [thinkingValue, setThinkingValue] = useState<boolean>(
    edge.condition?.type === 'thinking' ? edge.condition.value : true
  );
  const [playbackRate, setPlaybackRate] = useState<number>(edge.playback_rate ?? 1.0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resolveUrl = (url: string) =>
    url.startsWith('http') ? url : `${config.apiBaseUrl}${url}`;

  // Reset state when edge changes
  useEffect(() => {
    if (!open) return;

    const entries: VideoEntry[] = (edge.video_urls || []).map((url) => ({
      url,
      previewSrc: resolveUrl(url),
    }));
    setVideos(entries);

    setConditionType(edge.condition?.type || 'random');
    setMinInterval(edge.condition?.type === 'random' ? edge.condition.min_interval_ms / 1000 : 5);
    setMaxInterval(edge.condition?.type === 'random' ? edge.condition.max_interval_ms / 1000 : 15);
    setThinkingValue(edge.condition?.type === 'thinking' ? edge.condition.value : true);
    setPlaybackRate(edge.playback_rate ?? 1.0);
    setError('');
  }, [open, edge]);

  // Clean up blob URLs on unmount or when videos change
  useEffect(() => {
    return () => {
      for (const v of videos) {
        if (v.previewSrc.startsWith('blob:')) {
          URL.revokeObjectURL(v.previewSrc);
        }
      }
    };
  }, [videos]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    if (!file.type.startsWith('video/')) {
      setError('File must be a video (mp4 or webm)');
      return;
    }

    const previewSrc = URL.createObjectURL(file);
    setVideos((prev) => [...prev, { url: '', pendingFile: file, previewSrc }]);
    setError('');
  };

  const handleRemoveVideo = (index: number) => {
    setVideos((prev) => {
      const entry = prev[index];
      if (entry.previewSrc.startsWith('blob:')) {
        URL.revokeObjectURL(entry.previewSrc);
      }
      return prev.filter((_, i) => i !== index);
    });
  };

  const handleSave = async () => {
    setError('');
    setUploading(true);

    try {
      // Upload any pending files, assign indexed edge IDs
      const finalUrls: string[] = [];
      for (let i = 0; i < videos.length; i++) {
        const entry = videos[i];
        if (entry.pendingFile) {
          const storageId = `${edge.id}_${i}`;
          const result = await apiClient.uploadTransitionVideo(agentId, storageId, entry.pendingFile);
          finalUrls.push(result.video_url);
        } else if (entry.url) {
          finalUrls.push(entry.url);
        }
      }

      // Build condition
      let condition: TransitionCondition | undefined;
      if (conditionType === 'random') {
        const minMs = Math.max(100, Math.round(minInterval * 1000));
        const maxMs = Math.max(minMs + 100, Math.round(maxInterval * 1000));
        condition = {
          type: 'random',
          min_interval_ms: minMs,
          max_interval_ms: maxMs,
        };
      } else if (conditionType === 'thinking') {
        condition = {
          type: 'thinking',
          value: thinkingValue,
        };
      }

      onSave({
        ...edge,
        video_urls: finalUrls.length > 0 ? finalUrls : undefined,
        condition,
        playback_rate: playbackRate !== 1.0 ? playbackRate : undefined,
      });
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to save edge');
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="h6">
          {fromNodeName} &rarr; {toNodeName}
        </Typography>
        <IconButton onClick={onClose} size="small">
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}

        {/* Video list */}
        <Typography variant="subtitle2" sx={{ mb: 1 }}>Transition Videos</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Upload one or more videos (mp4/webm). A random one plays each time the transition fires. No videos = instant switch.
        </Typography>

        {videos.map((entry, index) => (
          <Box
            key={index}
            sx={{
              mb: 1.5,
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              p: 1,
              borderRadius: 1,
              border: '1px solid',
              borderColor: 'divider',
            }}
          >
            <video
              src={entry.previewSrc}
              controls
              style={{ width: 200, maxHeight: 120, borderRadius: 4, background: '#000', flexShrink: 0 }}
            />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="caption" color="text.secondary" noWrap>
                {entry.pendingFile ? entry.pendingFile.name : `Video ${index + 1}`}
              </Typography>
              {entry.pendingFile && (
                <Typography variant="caption" display="block" color="warning.main">
                  Not yet uploaded
                </Typography>
              )}
            </Box>
            <IconButton size="small" onClick={() => handleRemoveVideo(index)} color="error">
              <DeleteIcon fontSize="small" />
            </IconButton>
          </Box>
        ))}

        <input
          ref={fileInputRef}
          type="file"
          accept="video/mp4,video/webm"
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
        <Button
          variant="outlined"
          size="small"
          startIcon={<AddIcon />}
          onClick={() => fileInputRef.current?.click()}
          sx={{ mb: 3 }}
        >
          Add Video
        </Button>

        {/* Condition */}
        <Typography variant="subtitle2" sx={{ mb: 1 }}>Trigger Condition</Typography>
        <FormControl size="small" sx={{ mb: 2, minWidth: 200 }}>
          <InputLabel>Type</InputLabel>
          <Select
            value={conditionType}
            label="Type"
            onChange={(e) => setConditionType(e.target.value)}
          >
            <MenuItem value="random">Random Timer</MenuItem>
            <MenuItem value="thinking">Thinking</MenuItem>
          </Select>
        </FormControl>

        {conditionType === 'thinking' && (
          <FormControl size="small" sx={{ mb: 2, minWidth: 200 }}>
            <InputLabel>When</InputLabel>
            <Select
              value={thinkingValue ? 'true' : 'false'}
              label="When"
              onChange={(e) => setThinkingValue(e.target.value === 'true')}
            >
              <MenuItem value="true">True</MenuItem>
              <MenuItem value="false">False</MenuItem>
            </Select>
          </FormControl>
        )}

        {conditionType === 'random' && (
          <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
            <TextField
              label="Min interval (seconds)"
              type="number"
              size="small"
              value={minInterval}
              onChange={(e) => setMinInterval(Math.max(0.1, Number(e.target.value)))}
              inputProps={{ min: 0.1, step: 0.5 }}
              sx={{ flex: 1 }}
            />
            <TextField
              label="Max interval (seconds)"
              type="number"
              size="small"
              value={maxInterval}
              onChange={(e) => setMaxInterval(Math.max(0.1, Number(e.target.value)))}
              inputProps={{ min: 0.1, step: 0.5 }}
              sx={{ flex: 1 }}
            />
          </Box>
        )}

        {/* Playback rate */}
        <Typography variant="subtitle2" sx={{ mb: 1 }}>Video Playback Rate</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>{playbackRate.toFixed(2)}x</Typography>
        <Slider
          value={playbackRate}
          onChange={(_, v) => setPlaybackRate(v as number)}
          min={0.25}
          max={4}
          step={0.25}
          size="small"
          sx={{ mb: 2 }}
        />
      </DialogContent>

      <DialogActions>
        <Button
          color="error"
          startIcon={<DeleteIcon />}
          onClick={onDelete}
        >
          Delete Edge
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={uploading}
          startIcon={uploading ? <CircularProgress size={18} /> : undefined}
        >
          {uploading ? 'Uploading...' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
