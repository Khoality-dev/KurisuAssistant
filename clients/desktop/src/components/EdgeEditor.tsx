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
  Switch,
  FormControlLabel,
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
  url: string;
  pendingFile?: File;
  previewSrc: string;
}

interface TransitionState {
  conditions: Record<string, unknown>[];
  videos: VideoEntry[];
  playbackRate: number;
}

const DEFAULT_CONDITIONS: Record<string, Record<string, unknown>> = {
  random: { type: 'random', min_interval_ms: 5000, max_interval_ms: 15000 },
  thinking: { type: 'thinking', value: true },
  gesture: { type: 'gesture', value: 'wave' },
  face: { type: 'face', value: 'Unknown', visible: true },
};

function transitionToState(t: EdgeTransition): TransitionState {
  return {
    conditions: t.conditions.map((c) => ({ ...c } as Record<string, unknown>)),
    videos: (t.video_urls || []).map((url) => ({
      url,
      previewSrc: url.startsWith('http') ? url : `${config.apiBaseUrl}${url}`,
    })),
    playbackRate: t.playback_rate ?? 1.0,
  };
}

function defaultTransitionState(): TransitionState {
  return {
    conditions: [{ ...DEFAULT_CONDITIONS.random }],
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
  const [faceNames, setFaceNames] = useState<string[]>([]);
  const fileInputRefs = useRef<Map<number, HTMLInputElement>>(new Map());
  const activeFileInputIdx = useRef<number>(0);
  // Track all created blob URLs so we can revoke them only on unmount
  const blobUrlsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setTransitions(
      edge.transitions.length > 0
        ? edge.transitions.map(transitionToState)
        : [defaultTransitionState()],
    );
    setError('');
    apiClient.listFaces().then((faces) => {
      setFaceNames(faces.map((f) => f.name));
    }).catch(() => {});
  }, [open, edge]);

  // Revoke blob URLs only on unmount
  useEffect(() => {
    return () => {
      for (const url of blobUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
      blobUrlsRef.current.clear();
    };
  }, []);

  const updateTransition = useCallback((idx: number, partial: Partial<TransitionState>) => {
    setTransitions((prev) => prev.map((t, i) => (i === idx ? { ...t, ...partial } : t)));
  }, []);

  const updateConditionField = useCallback((tIdx: number, cIdx: number, key: string, value: unknown) => {
    setTransitions((prev) =>
      prev.map((t, i) => {
        if (i !== tIdx) return t;
        const conditions = t.conditions.map((c, ci) =>
          ci === cIdx ? { ...c, [key]: value } : c,
        );
        return { ...t, conditions };
      }),
    );
  }, []);

  const handleConditionTypeChange = useCallback((tIdx: number, cIdx: number, newType: string) => {
    const defaultCond = DEFAULT_CONDITIONS[newType] || { type: newType };
    setTransitions((prev) =>
      prev.map((t, i) => {
        if (i !== tIdx) return t;
        const conditions = t.conditions.map((c, ci) =>
          ci === cIdx ? { ...defaultCond } : c,
        );
        return { ...t, conditions };
      }),
    );
  }, []);

  const handleAddCondition = useCallback((tIdx: number) => {
    setTransitions((prev) =>
      prev.map((t, i) =>
        i === tIdx ? { ...t, conditions: [...t.conditions, { ...DEFAULT_CONDITIONS.random }] } : t,
      ),
    );
  }, []);

  const handleRemoveCondition = useCallback((tIdx: number, cIdx: number) => {
    setTransitions((prev) =>
      prev.map((t, i) =>
        i === tIdx ? { ...t, conditions: t.conditions.filter((_, ci) => ci !== cIdx) } : t,
      ),
    );
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;
    const tIdx = activeFileInputIdx.current;

    const newEntries: VideoEntry[] = [];
    for (const file of files) {
      const previewSrc = URL.createObjectURL(file);
      blobUrlsRef.current.add(previewSrc);
      newEntries.push({ url: '', pendingFile: file, previewSrc });
    }

    setTransitions((prev) =>
      prev.map((t, i) =>
        i === tIdx ? { ...t, videos: [...t.videos, ...newEntries] } : t,
      ),
    );
    setError('');
  };

  const handleRemoveVideo = (tIdx: number, vIdx: number) => {
    setTransitions((prev) =>
      prev.map((t, i) => {
        if (i !== tIdx) return t;
        const entry = t.videos[vIdx];
        if (entry.previewSrc.startsWith('blob:')) {
          URL.revokeObjectURL(entry.previewSrc);
          blobUrlsRef.current.delete(entry.previewSrc);
        }
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

        finalTransitions.push({
          conditions: ts.conditions as unknown as TransitionCondition[],
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

  const GESTURE_OPTIONS = ['wave', 'thumbs_up', 'peace_sign', 'pointing', 'open_palm'];

  const renderConditionField = (tIdx: number, cIdx: number, condType: string, key: string, value: unknown) => {
    // Gesture value — dropdown of gesture names
    if (condType === 'gesture' && key === 'value') {
      return (
        <FormControl key={key} size="small" sx={{ mb: 0.5, mr: 1, flex: 1, minWidth: 120 }}>
          <InputLabel>{key}</InputLabel>
          <Select
            value={String(value)}
            label={key}
            onChange={(e) => updateConditionField(tIdx, cIdx, key, e.target.value)}
          >
            {GESTURE_OPTIONS.map((g) => (
              <MenuItem key={g} value={g}>{g.replace(/_/g, ' ')}</MenuItem>
            ))}
          </Select>
        </FormControl>
      );
    }
    // Face value — dropdown of registered faces + "unknown"
    if (condType === 'face' && key === 'value') {
      const options = ['Unknown', ...faceNames];
      return (
        <FormControl key={key} size="small" sx={{ mb: 0.5, mr: 1, flex: 1, minWidth: 120 }}>
          <InputLabel>{key}</InputLabel>
          <Select
            value={String(value)}
            label={key}
            onChange={(e) => updateConditionField(tIdx, cIdx, key, e.target.value)}
          >
            {options.map((name) => (
              <MenuItem key={name} value={name}>{name}</MenuItem>
            ))}
          </Select>
        </FormControl>
      );
    }
    if (typeof value === 'boolean') {
      return (
        <FormControlLabel
          key={key}
          control={
            <Switch
              checked={value}
              onChange={(e) => updateConditionField(tIdx, cIdx, key, e.target.checked)}
              size="small"
            />
          }
          label={key}
          sx={{ mb: 0.5 }}
        />
      );
    }
    if (typeof value === 'number') {
      return (
        <TextField
          key={key}
          label={key}
          type="number"
          size="small"
          value={value}
          onChange={(e) => updateConditionField(tIdx, cIdx, key, Number(e.target.value))}
          sx={{ mb: 0.5, mr: 1, flex: 1, minWidth: 120 }}
        />
      );
    }
    return (
      <TextField
        key={key}
        label={key}
        size="small"
        value={String(value)}
        onChange={(e) => updateConditionField(tIdx, cIdx, key, e.target.value)}
        sx={{ mb: 0.5, mr: 1, flex: 1, minWidth: 120 }}
      />
    );
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

            {/* Conditions (AND logic) */}
            {ts.conditions.map((cond, cIdx) => (
              <Box
                key={cIdx}
                sx={{
                  mb: 1,
                  p: 1,
                  borderRadius: 1,
                  bgcolor: 'action.hover',
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                  {cIdx > 0 && (
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 'bold' }}>
                      AND
                    </Typography>
                  )}
                  <FormControl size="small" sx={{ minWidth: 160 }}>
                    <InputLabel>Condition</InputLabel>
                    <Select
                      value={cond.type as string}
                      label="Condition"
                      onChange={(e) => handleConditionTypeChange(tIdx, cIdx, e.target.value)}
                    >
                      <MenuItem value="random">Random Timer</MenuItem>
                      <MenuItem value="thinking">Thinking</MenuItem>
                      <MenuItem value="gesture">Gesture</MenuItem>
                      <MenuItem value="face">Face</MenuItem>
                    </Select>
                  </FormControl>
                  <Box sx={{ flex: 1 }} />
                  {ts.conditions.length > 1 && (
                    <IconButton
                      size="small"
                      color="error"
                      onClick={() => handleRemoveCondition(tIdx, cIdx)}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  )}
                </Box>

                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
                  {Object.entries(cond)
                    .filter(([key]) => key !== 'type')
                    .map(([key, value]) => renderConditionField(tIdx, cIdx, cond.type as string, key, value))}
                </Box>
              </Box>
            ))}

            <Button
              variant="text"
              size="small"
              startIcon={<AddIcon />}
              onClick={() => handleAddCondition(tIdx)}
              sx={{ mb: 1 }}
            >
              Add Condition
            </Button>

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
              multiple
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
