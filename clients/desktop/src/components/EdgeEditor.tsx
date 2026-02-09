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
} from '@mui/material';
import {
  CloudUpload as CloudUploadIcon,
  Close as CloseIcon,
  Delete as DeleteIcon,
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
  const [videoUrl, setVideoUrl] = useState<string | undefined>(edge.video_url);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [conditionType, setConditionType] = useState<string>(edge.condition?.type || 'random');
  const [minInterval, setMinInterval] = useState<number>(
    edge.condition?.type === 'random' ? edge.condition.min_interval_ms / 1000 : 5
  );
  const [maxInterval, setMaxInterval] = useState<number>(
    edge.condition?.type === 'random' ? edge.condition.max_interval_ms / 1000 : 15
  );
  const [thinkingTrigger, setThinkingTrigger] = useState<'start' | 'end'>(
    edge.condition?.type === 'thinking' ? edge.condition.trigger : 'start'
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  // Reset state when edge changes
  useEffect(() => {
    if (!open) return;
    setVideoUrl(edge.video_url);
    setPendingFile(null);
    setConditionType(edge.condition?.type || 'random');
    setMinInterval(edge.condition?.type === 'random' ? edge.condition.min_interval_ms / 1000 : 5);
    setMaxInterval(edge.condition?.type === 'random' ? edge.condition.max_interval_ms / 1000 : 15);
    setThinkingTrigger(edge.condition?.type === 'thinking' ? edge.condition.trigger : 'start');
    setError('');

    // Set preview source
    if (edge.video_url) {
      const url = edge.video_url.startsWith('http')
        ? edge.video_url
        : `${config.apiBaseUrl}${edge.video_url}`;
      setPreviewSrc(url);
    } else {
      setPreviewSrc(null);
    }
  }, [open, edge]);

  // Clean up object URL on unmount
  useEffect(() => {
    return () => {
      if (previewSrc && previewSrc.startsWith('blob:')) {
        URL.revokeObjectURL(previewSrc);
      }
    };
  }, [previewSrc]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    // Validate type
    if (!file.type.startsWith('video/')) {
      setError('File must be a video (mp4 or webm)');
      return;
    }

    setPendingFile(file);
    // Show local preview
    if (previewSrc && previewSrc.startsWith('blob:')) {
      URL.revokeObjectURL(previewSrc);
    }
    setPreviewSrc(URL.createObjectURL(file));
    setError('');
  };

  const handleSave = async () => {
    setError('');
    setUploading(true);

    try {
      let finalVideoUrl = videoUrl;

      // Upload video if a new file was selected
      if (pendingFile) {
        const result = await apiClient.uploadTransitionVideo(agentId, edge.id, pendingFile);
        finalVideoUrl = result.video_url;
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
          trigger: thinkingTrigger,
        };
      }

      onSave({
        ...edge,
        video_url: finalVideoUrl,
        condition,
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

        {/* Video upload */}
        <Typography variant="subtitle2" sx={{ mb: 1 }}>Transition Video</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Upload a video (mp4/webm) that plays during this transition. If no video is set, the transition is instant.
        </Typography>

        {previewSrc && (
          <Box sx={{ mb: 2 }}>
            <video
              src={previewSrc}
              controls
              style={{ width: '100%', maxHeight: 300, borderRadius: 8, background: '#000' }}
            />
          </Box>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="video/mp4,video/webm"
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
        <Button
          variant="outlined"
          startIcon={<CloudUploadIcon />}
          onClick={() => fileInputRef.current?.click()}
          sx={{ mb: 3 }}
        >
          {previewSrc ? 'Replace Video' : 'Upload Video'}
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
            <InputLabel>Trigger</InputLabel>
            <Select
              value={thinkingTrigger}
              label="Trigger"
              onChange={(e) => setThinkingTrigger(e.target.value as 'start' | 'end')}
            >
              <MenuItem value="start">Thinking starts</MenuItem>
              <MenuItem value="end">Thinking ends</MenuItem>
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
          {uploading ? 'Saving...' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
