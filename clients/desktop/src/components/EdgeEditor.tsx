import React, { useState, useRef, useEffect, useCallback } from 'react';
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
  Close as CloseIcon,
  Delete as DeleteIcon,
  Add as AddIcon,
} from '@mui/icons-material';
import { apiClient } from '../api/client';
import { config } from '../config';
import type { AnimationEdge, EdgeTransition, TransitionCondition } from '../videocall/types';

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

interface TransitionState {
  conditionType: string;
  minInterval: number;
  maxInterval: number;
  thinkingValue: boolean;
  gestureValue: string;
  videos: VideoEntry[];
  playbackRate: number;
}

const GESTURE_OPTIONS = ['wave', 'thumbs_up', 'peace_sign', 'pointing', 'open_palm'];

function transitionToState(t: EdgeTransition): TransitionState {
  return {
    conditionType: t.condition.type,
    minInterval: t.condition.type === 'random' ? t.condition.min_interval_ms / 1000 : 5,
    maxInterval: t.condition.type === 'random' ? t.condition.max_interval_ms / 1000 : 15,
    thinkingValue: t.condition.type === 'thinking' ? t.condition.value : true,
    gestureValue: t.condition.type === 'gesture' ? t.condition.value : 'wave',
    videos: (t.video_urls || []).map((url) => ({
      url,
      previewSrc: url.startsWith('http') ? url : `${config.apiBaseUrl}${url}`,
    })),
    playbackRate: t.playback_rate ?? 1.0,
  };
}

function defaultTransitionState(): TransitionState {
  return {
    conditionType: 'random',
    minInterval: 5,
    maxInterval: 15,
    thinkingValue: true,
    gestureValue: 'wave',
    videos: [],
    playbackRate: 1.0,
  };
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
  const [transitions, setTransitions] = useState<TransitionState[]>([]);
  const fileInputRefs = useRef<Map<number, HTMLInputElement>>(new Map());
  // Track which transition index the file input belongs to
  const activeFileInputIdx = useRef<number>(0);

  // Reset state when edge changes
  useEffect(() => {
    if (!open) return;
    setTransitions(
      edge.transitions.length > 0
        ? edge.transitions.map(transitionToState)
        : [defaultTransitionState()],
    );
    setError('');
  }, [open, edge]);

  // Clean up blob URLs on unmount
  useEffect(() => {
    return () => {
      for (const t of transitions) {
        for (const v of t.videos) {
          if (v.previewSrc.startsWith('blob:')) URL.revokeObjectURL(v.previewSrc);
        }
      }
    };
  }, [transitions]);

  const updateTransition = useCallback((idx: number, partial: Partial<TransitionState>) => {
    setTransitions((prev) => prev.map((t, i) => (i === idx ? { ...t, ...partial } : t)));
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    const tIdx = activeFileInputIdx.current;

    if (!file.type.startsWith('video/')) {
      setError('File must be a video (mp4 or webm)');
      return;
    }

    const previewSrc = URL.createObjectURL(file);
    setTransitions((prev) =>
      prev.map((t, i) =>
        i === tIdx ? { ...t, videos: [...t.videos, { url: '', pendingFile: file, previewSrc }] } : t,
      ),
    );
    setError('');
  };

  const handleRemoveVideo = (tIdx: number, vIdx: number) => {
    setTransitions((prev) =>
      prev.map((t, i) => {
        if (i !== tIdx) return t;
        const entry = t.videos[vIdx];
        if (entry.previewSrc.startsWith('blob:')) URL.revokeObjectURL(entry.previewSrc);
        return { ...t, videos: t.videos.filter((_, vi) => vi !== vIdx) };
      }),
    );
  };

  const handleDeleteTransition = (tIdx: number) => {
    setTransitions((prev) => prev.filter((_, i) => i !== tIdx));
  };

  const handleAddTransition = () => {
    setTransitions((prev) => [...prev, defaultTransitionState()]);
  };

  const handleSave = async () => {
    setError('');
    setUploading(true);

    try {
      const finalTransitions: EdgeTransition[] = [];

      for (let ti = 0; ti < transitions.length; ti++) {
        const ts = transitions[ti];

        // Upload pending video files
        const finalUrls: string[] = [];
        for (let vi = 0; vi < ts.videos.length; vi++) {
          const entry = ts.videos[vi];
          if (entry.pendingFile) {
            const storageId = `${edge.id}_t${ti}_${vi}`;
            const result = await apiClient.uploadTransitionVideo(agentId, storageId, entry.pendingFile);
            finalUrls.push(result.video_url);
          } else if (entry.url) {
            finalUrls.push(entry.url);
          }
        }

        // Build condition
        let condition: TransitionCondition;
        if (ts.conditionType === 'thinking') {
          condition = { type: 'thinking', value: ts.thinkingValue };
        } else if (ts.conditionType === 'gesture') {
          condition = { type: 'gesture', value: ts.gestureValue };
        } else {
          const minMs = Math.max(100, Math.round(ts.minInterval * 1000));
          const maxMs = Math.max(minMs + 100, Math.round(ts.maxInterval * 1000));
          condition = { type: 'random', min_interval_ms: minMs, max_interval_ms: maxMs };
        }

        finalTransitions.push({
          condition,
          video_urls: finalUrls.length > 0 ? finalUrls : undefined,
          playback_rate: ts.playbackRate !== 1.0 ? ts.playbackRate : undefined,
        });
      }

      onSave({
        ...edge,
        transitions: finalTransitions,
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

        {transitions.map((ts, tIdx) => (
          <Box
            key={tIdx}
            sx={{
              mb: 2,
              p: 2,
              borderRadius: 1,
              border: '1px solid',
              borderColor: 'divider',
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
              <Typography variant="subtitle2">Transition {tIdx + 1}</Typography>
              <IconButton
                size="small"
                color="error"
                onClick={() => handleDeleteTransition(tIdx)}
                disabled={transitions.length <= 1}
                title={transitions.length <= 1 ? 'At least one transition required' : 'Delete transition'}
              >
                <DeleteIcon fontSize="small" />
              </IconButton>
            </Box>

            {/* Condition */}
            <FormControl size="small" sx={{ mb: 1.5, minWidth: 200 }}>
              <InputLabel>Condition</InputLabel>
              <Select
                value={ts.conditionType}
                label="Condition"
                onChange={(e) => updateTransition(tIdx, { conditionType: e.target.value })}
              >
                <MenuItem value="random">Random Timer</MenuItem>
                <MenuItem value="thinking">Thinking</MenuItem>
                <MenuItem value="gesture">Gesture</MenuItem>
              </Select>
            </FormControl>

            {ts.conditionType === 'random' && (
              <Box sx={{ display: 'flex', gap: 2, mb: 1.5 }}>
                <TextField
                  label="Min (s)"
                  type="number"
                  size="small"
                  value={ts.minInterval}
                  onChange={(e) => updateTransition(tIdx, { minInterval: Math.max(0.1, Number(e.target.value)) })}
                  inputProps={{ min: 0.1, step: 0.5 }}
                  sx={{ flex: 1 }}
                />
                <TextField
                  label="Max (s)"
                  type="number"
                  size="small"
                  value={ts.maxInterval}
                  onChange={(e) => updateTransition(tIdx, { maxInterval: Math.max(0.1, Number(e.target.value)) })}
                  inputProps={{ min: 0.1, step: 0.5 }}
                  sx={{ flex: 1 }}
                />
              </Box>
            )}

            {ts.conditionType === 'thinking' && (
              <FormControl size="small" sx={{ mb: 1.5, minWidth: 200 }}>
                <InputLabel>When</InputLabel>
                <Select
                  value={ts.thinkingValue ? 'true' : 'false'}
                  label="When"
                  onChange={(e) => updateTransition(tIdx, { thinkingValue: e.target.value === 'true' })}
                >
                  <MenuItem value="true">Thinking starts</MenuItem>
                  <MenuItem value="false">Thinking ends</MenuItem>
                </Select>
              </FormControl>
            )}

            {ts.conditionType === 'gesture' && (
              <FormControl size="small" sx={{ mb: 1.5, minWidth: 200 }}>
                <InputLabel>Gesture</InputLabel>
                <Select
                  value={ts.gestureValue}
                  label="Gesture"
                  onChange={(e) => updateTransition(tIdx, { gestureValue: e.target.value })}
                >
                  {GESTURE_OPTIONS.map((g) => (
                    <MenuItem key={g} value={g}>{g.replace('_', ' ')}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}

            {/* Videos */}
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Videos (random pick per fire, none = instant switch)
            </Typography>

            {ts.videos.map((entry, vIdx) => (
              <Box
                key={vIdx}
                sx={{
                  mb: 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  p: 0.5,
                  borderRadius: 1,
                  border: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <video
                  src={entry.previewSrc}
                  controls
                  style={{ width: 160, maxHeight: 90, borderRadius: 4, background: '#000', flexShrink: 0 }}
                />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {entry.pendingFile ? entry.pendingFile.name : `Video ${vIdx + 1}`}
                  </Typography>
                  {entry.pendingFile && (
                    <Typography variant="caption" display="block" color="warning.main">
                      Pending upload
                    </Typography>
                  )}
                </Box>
                <IconButton size="small" onClick={() => handleRemoveVideo(tIdx, vIdx)} color="error">
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Box>
            ))}

            <input
              ref={(el) => { if (el) fileInputRefs.current.set(tIdx, el); }}
              type="file"
              accept="video/mp4,video/webm"
              style={{ display: 'none' }}
              onChange={handleFileSelect}
            />
            <Button
              variant="text"
              size="small"
              startIcon={<AddIcon />}
              onClick={() => {
                activeFileInputIdx.current = tIdx;
                fileInputRefs.current.get(tIdx)?.click();
              }}
              sx={{ mb: 0.5 }}
            >
              Add Video
            </Button>

            {/* Playback rate */}
            <Box sx={{ mt: 1 }}>
              <Typography variant="caption" color="text.secondary">
                Playback rate: {ts.playbackRate.toFixed(2)}x
              </Typography>
              <Slider
                value={ts.playbackRate}
                onChange={(_, v) => updateTransition(tIdx, { playbackRate: v as number })}
                min={0.25}
                max={4}
                step={0.25}
                size="small"
              />
            </Box>
          </Box>
        ))}

        <Button
          variant="outlined"
          size="small"
          startIcon={<AddIcon />}
          onClick={handleAddTransition}
          fullWidth
        >
          Add Transition
        </Button>
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
