import React, { useState, useRef, useEffect } from 'react';
import {
  Box,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Stepper,
  Step,
  StepLabel,
  Button,
  Typography,
  IconButton,
  Alert,
  CircularProgress,
  ToggleButtonGroup,
  ToggleButton,
  Switch,
  FormControlLabel,
  Tooltip,
  List,
  ListItem,
  ListItemText,
  ListItemAvatar,
  ListItemSecondaryAction,
  TextField,
} from '@mui/material';
import {
  CloudUpload as CloudUploadIcon,
  Close as CloseIcon,
  ArrowUpward as ArrowUpwardIcon,
  ArrowDownward as ArrowDownwardIcon,
  Delete as DeleteIcon,
  Face as FaceIcon,
} from '@mui/icons-material';
import { apiClient } from '../api/client';
import { config } from '../config';
import type { PatchInfo, PoseConfig } from '../videocall/types';
import { CanvasCompositor } from '../videocall/engine/CanvasCompositor';

const STEPS = ['Base Image', 'Keyframes', 'Preview'];

type PatchCategory = 'left_eye' | 'right_eye' | 'mouth';

interface CategoryPatch extends PatchInfo {
  category: PatchCategory;
}

// ─── Self-contained canvas preview ───

interface PreviewCanvasProps {
  poseConfig: PoseConfig;
  testMouth: boolean;
  testLeftEye: boolean;
  testRightEye: boolean;
  breathing: boolean;
}

const PREVIEW_W = 400;
const PREVIEW_H = 540;

const PreviewCanvas: React.FC<PreviewCanvasProps> = ({ poseConfig, testMouth, testLeftEye, testRightEye, breathing }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compositorRef = useRef<CanvasCompositor | null>(null);
  const mouthAnimRef = useRef<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = PREVIEW_W * dpr;
    canvas.height = PREVIEW_H * dpr;

    if (compositorRef.current) {
      compositorRef.current.destroy();
    }

    const compositor = new CanvasCompositor(canvas);
    compositorRef.current = compositor;
    setLoading(true);
    setLoadError('');

    let cancelled = false;

    compositor
      .loadPose(poseConfig, config.apiBaseUrl)
      .then(() => {
        if (!cancelled) {
          compositor.start();
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Preview load failed:', err);
          setLoadError(err.message || 'Failed to load preview');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      compositor.destroy();
      compositorRef.current = null;
    };
  }, [poseConfig]);

  useEffect(() => {
    const compositor = compositorRef.current;
    if (!compositor) return;

    if (!testMouth) {
      compositor.mouthAmplitude = 0;
      compositor.isAudioPlaying = false;
      if (mouthAnimRef.current) {
        cancelAnimationFrame(mouthAnimRef.current);
        mouthAnimRef.current = null;
      }
      return;
    }

    compositor.isAudioPlaying = true;
    const startTime = performance.now();
    const animate = () => {
      if (compositorRef.current) {
        const t = (performance.now() - startTime) / 1000;
        compositorRef.current.mouthAmplitude = (Math.sin(t * 4) + 1) / 2;
      }
      mouthAnimRef.current = requestAnimationFrame(animate);
    };
    mouthAnimRef.current = requestAnimationFrame(animate);

    return () => {
      if (mouthAnimRef.current) {
        cancelAnimationFrame(mouthAnimRef.current);
        mouthAnimRef.current = null;
      }
    };
  }, [testMouth]);

  useEffect(() => {
    const compositor = compositorRef.current;
    if (!compositor) return;

    if (testLeftEye) {
      const numPatches = poseConfig.left_eye.patches.length;
      if (numPatches > 0) {
        compositor.leftEyeOverride = 1;
        let idx = 1;
        const interval = setInterval(() => {
          idx = idx >= numPatches ? 0 : idx + 1;
          if (compositorRef.current) compositorRef.current.leftEyeOverride = idx;
        }, 500);
        return () => {
          clearInterval(interval);
          if (compositorRef.current) compositorRef.current.leftEyeOverride = -1;
        };
      }
    } else {
      compositor.leftEyeOverride = -1;
    }
  }, [testLeftEye, poseConfig]);

  useEffect(() => {
    const compositor = compositorRef.current;
    if (!compositor) return;

    if (testRightEye) {
      const numPatches = poseConfig.right_eye.patches.length;
      if (numPatches > 0) {
        compositor.rightEyeOverride = 1;
        let idx = 1;
        const interval = setInterval(() => {
          idx = idx >= numPatches ? 0 : idx + 1;
          if (compositorRef.current) compositorRef.current.rightEyeOverride = idx;
        }, 500);
        return () => {
          clearInterval(interval);
          if (compositorRef.current) compositorRef.current.rightEyeOverride = -1;
        };
      }
    } else {
      compositor.rightEyeOverride = -1;
    }
  }, [testRightEye, poseConfig]);

  useEffect(() => {
    const compositor = compositorRef.current;
    if (!compositor) return;
    compositor.breathingEnabled = breathing;
  }, [breathing]);

  return (
    <Box
      sx={{
        width: PREVIEW_W,
        height: PREVIEW_H,
        flexShrink: 0,
        border: '2px solid',
        borderColor: 'primary.main',
        borderRadius: 2,
        overflow: 'hidden',
        bgcolor: 'grey.100',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: PREVIEW_W, height: PREVIEW_H }}
      />
      {loading && (
        <CircularProgress
          size={40}
          sx={{ position: 'absolute', color: 'primary.main' }}
        />
      )}
      {loadError && (
        <Typography
          variant="caption"
          color="error"
          sx={{ position: 'absolute', textAlign: 'center', px: 2 }}
        >
          {loadError}
        </Typography>
      )}
    </Box>
  );
};

// ─── PoseNodeEditor sub-dialog ───

export interface PoseNodeEditorProps {
  open: boolean;
  agentId: number;
  poseId: string;
  initialPoseConfig: PoseConfig | null;
  nodeName: string;
  onSave: (poseConfig: PoseConfig, name: string) => void;
  onClose: () => void;
}

export const PoseNodeEditor: React.FC<PoseNodeEditorProps> = ({
  open,
  agentId,
  poseId,
  initialPoseConfig,
  nodeName,
  onSave,
  onClose,
}) => {
  const [activeStep, setActiveStep] = useState(0);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [name, setName] = useState(nodeName);

  // Step 1: Base image
  const [hasBase, setHasBase] = useState(false);
  const [baseImageUrl, setBaseImageUrl] = useState<string | null>(null);
  const baseInputRef = useRef<HTMLInputElement>(null);

  // Step 2: Keyframes
  const [selectedCategory, setSelectedCategory] = useState<PatchCategory>('left_eye');
  const [patches, setPatches] = useState<CategoryPatch[]>([]);
  const keyframeInputRef = useRef<HTMLInputElement>(null);

  // Step 3: Preview
  const [testMouth, setTestMouth] = useState(false);
  const [testLeftEye, setTestLeftEye] = useState(false);
  const [testRightEye, setTestRightEye] = useState(false);
  const [breathing, setBreathing] = useState(true);

  // Load initial config when dialog opens
  useEffect(() => {
    if (!open) return;
    setName(nodeName);
    setActiveStep(0);
    setError('');
    setTestMouth(false);
    setTestLeftEye(false);
    setTestRightEye(false);
    setBreathing(true);

    if (initialPoseConfig) {
      loadFromPoseConfig(initialPoseConfig);
    } else {
      setHasBase(false);
      setBaseImageUrl(null);
      setPatches([]);
      setSelectedCategory('left_eye');
    }
  }, [open]);

  // Helper: build the canonical base image URL from agentId + poseId
  const baseAssetUrl = `/character-assets/${agentId}/${poseId}/base`;

  const loadFromPoseConfig = (pc: PoseConfig) => {
    try {
      // Always use canonical URL for display (handles old UUID-based URLs too)
      setHasBase(true);
      setBaseImageUrl(`${config.apiBaseUrl}${baseAssetUrl}`);

      const existingPatches: CategoryPatch[] = [];
      for (const p of pc.left_eye.patches) {
        existingPatches.push({ ...p, category: 'left_eye' });
      }
      for (const p of pc.right_eye.patches) {
        existingPatches.push({ ...p, category: 'right_eye' });
      }
      for (const p of pc.mouth.patches) {
        existingPatches.push({ ...p, category: 'mouth' });
      }
      // Normalize patch URLs to new format
      const normalized = existingPatches.map((p, _i) => {
        const catPatches = existingPatches.filter((pp) => pp.category === p.category);
        const idx = catPatches.indexOf(p);
        return {
          ...p,
          image_url: `/character-assets/${agentId}/${poseId}/${p.category}_${idx}`,
        };
      });
      setPatches(normalized);
    } catch (err) {
      console.error('Failed to load pose config:', err);
    }
  };

  const buildPoseConfig = (): PoseConfig | null => {
    if (!hasBase) return null;

    const buildPatches = (category: PatchCategory) =>
      patches
        .filter((p) => p.category === category)
        .map(({ category: _cat, ...rest }, idx) => ({
          ...rest,
          image_url: `/character-assets/${agentId}/${poseId}/${category}_${idx}`,
        }));

    return {
      name: name || 'Untitled',
      base_image_url: baseAssetUrl,
      left_eye: { patches: buildPatches('left_eye') },
      right_eye: { patches: buildPatches('right_eye') },
      mouth: { patches: buildPatches('mouth') },
    };
  };

  const handleUploadBase = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    setUploading(true);
    setError('');
    try {
      await apiClient.uploadCharacterBase(agentId, poseId, file);
      setHasBase(true);
      // Use canonical URL with cache-bust to show updated image
      setBaseImageUrl(`${config.apiBaseUrl}${baseAssetUrl}?t=${Date.now()}`);
      if (patches.length > 0) {
        setPatches([]);
      }
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to upload base image');
    } finally {
      setUploading(false);
    }
  };

  const handleUploadKeyframe = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !hasBase) return;
    e.target.value = '';

    setUploading(true);
    setError('');
    try {
      const categoryCount = patches.filter((p) => p.category === selectedCategory).length;
      const result = await apiClient.computeCharacterPatch(
        agentId, poseId, file, selectedCategory, categoryCount,
      );
      const newPatch: CategoryPatch = {
        ...result.patch,
        image_url: `/character-assets/${agentId}/${poseId}/${selectedCategory}_${categoryCount}`,
        category: selectedCategory,
      };
      setPatches((prev) => [...prev, newPatch]);
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to compute patch');
    } finally {
      setUploading(false);
    }
  };

  const handleDeletePatch = (index: number) => {
    setPatches((prev) => prev.filter((_, i) => i !== index));
  };

  const handleMovePatch = (index: number, direction: 'up' | 'down') => {
    setPatches((prev) => {
      const arr = [...prev];
      const category = arr[index].category;
      const categoryIndices = arr
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => p.category === category)
        .map(({ i }) => i);

      const posInCategory = categoryIndices.indexOf(index);
      const swapPosInCategory = direction === 'up' ? posInCategory - 1 : posInCategory + 1;
      if (swapPosInCategory < 0 || swapPosInCategory >= categoryIndices.length) return prev;

      const swapIndex = categoryIndices[swapPosInCategory];
      [arr[index], arr[swapIndex]] = [arr[swapIndex], arr[index]];
      return arr;
    });
  };

  const handleSave = () => {
    const poseConfig = buildPoseConfig();
    if (!poseConfig) {
      setError('No base image configured');
      return;
    }
    onSave(poseConfig, name || 'Untitled');
  };

  const getPatchesForCategory = (category: PatchCategory) =>
    patches
      .map((p, i) => ({ patch: p, globalIndex: i }))
      .filter(({ patch }) => patch.category === category);

  const resolvePatchUrl = (url: string) =>
    url.startsWith('http') ? url : `${config.apiBaseUrl}${url}`;

  const categoryLabel = (cat: PatchCategory) => {
    switch (cat) {
      case 'left_eye': return 'Left Eye';
      case 'right_eye': return 'Right Eye';
      case 'mouth': return 'Mouth';
    }
  };

  const poseConfig = buildPoseConfig();
  const mouthCount = getPatchesForCategory('mouth').length;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Typography variant="h6">Edit Pose</Typography>
          <TextField
            size="small"
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            sx={{ width: 200 }}
          />
        </Box>
        <IconButton onClick={onClose} size="small">
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers>
        <Stepper activeStep={activeStep} sx={{ mb: 4 }}>
          {STEPS.map((label) => (
            <Step key={label}>
              <StepLabel>{label}</StepLabel>
            </Step>
          ))}
        </Stepper>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}

        {/* Step 1: Base Image */}
        {activeStep === 0 && (
          <Box sx={{ display: 'flex', gap: 4, alignItems: 'flex-start', minHeight: 300 }}>
            <Box
              sx={{
                width: PREVIEW_W,
                height: PREVIEW_H,
                flexShrink: 0,
                border: '2px dashed',
                borderColor: baseImageUrl ? 'primary.main' : 'divider',
                borderRadius: 2,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                bgcolor: 'grey.50',
              }}
            >
              {baseImageUrl ? (
                <Box
                  component="img"
                  src={baseImageUrl}
                  sx={{ width: '100%', height: '100%', objectFit: 'contain' }}
                />
              ) : (
                <FaceIcon sx={{ fontSize: 80, color: 'grey.300' }} />
              )}
            </Box>

            <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Typography variant="h6">Base Portrait</Typography>
              <Typography variant="body2" color="text.secondary">
                Upload the character's default expression — eyes open, mouth closed. This is the base
                layer that all animation patches overlay on top of.
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Recommended: PNG with transparent background, 512x768 or similar portrait aspect ratio.
              </Typography>

              <input
                ref={baseInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={handleUploadBase}
              />
              <Button
                variant="contained"
                startIcon={uploading ? <CircularProgress size={18} /> : <CloudUploadIcon />}
                onClick={() => baseInputRef.current?.click()}
                disabled={uploading}
              >
                {baseImageUrl ? 'Replace Base Image' : 'Upload Base Image'}
              </Button>

              {hasBase && (
                <Alert severity="success" sx={{ mt: 1 }}>
                  Base image uploaded
                </Alert>
              )}
            </Box>
          </Box>
        )}

        {/* Step 2: Keyframes */}
        {activeStep === 1 && (
          <Box sx={{ minHeight: 300 }}>
            <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', mb: 3 }}>
              <ToggleButtonGroup
                value={selectedCategory}
                exclusive
                onChange={(_, val) => val && setSelectedCategory(val as PatchCategory)}
                size="small"
              >
                <ToggleButton value="left_eye">
                  Left Eye ({getPatchesForCategory('left_eye').length})
                </ToggleButton>
                <ToggleButton value="right_eye">
                  Right Eye ({getPatchesForCategory('right_eye').length})
                </ToggleButton>
                <ToggleButton value="mouth">
                  Mouth ({getPatchesForCategory('mouth').length})
                </ToggleButton>
              </ToggleButtonGroup>

              <input
                ref={keyframeInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={handleUploadKeyframe}
              />
              <Button
                variant="contained"
                size="small"
                startIcon={uploading ? <CircularProgress size={16} /> : <CloudUploadIcon />}
                onClick={() => keyframeInputRef.current?.click()}
                disabled={uploading || !hasBase}
              >
                Upload Keyframe
              </Button>
            </Box>

            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Upload variants of the base image with different {categoryLabel(selectedCategory).toLowerCase()} expressions.
              The backend will compute the diff automatically. Order matters — patches are played sequentially during animation.
            </Typography>

            {getPatchesForCategory(selectedCategory).length === 0 ? (
              <Box sx={{ textAlign: 'center', py: 4, color: 'text.secondary' }}>
                <Typography>No {categoryLabel(selectedCategory).toLowerCase()} patches yet.</Typography>
                <Typography variant="caption">
                  Upload a keyframe variant to add one.
                </Typography>
              </Box>
            ) : (
              <List dense>
                {getPatchesForCategory(selectedCategory).map(({ patch, globalIndex }, posInCategory) => (
                  <ListItem
                    key={globalIndex}
                    sx={{
                      border: '1px solid',
                      borderColor: 'divider',
                      borderRadius: 1,
                      mb: 1,
                    }}
                  >
                    <ListItemAvatar>
                      <Box
                        component="img"
                        src={resolvePatchUrl(patch.image_url)}
                        sx={{
                          width: 48,
                          height: 48,
                          objectFit: 'contain',
                          borderRadius: 1,
                          bgcolor: 'grey.100',
                        }}
                      />
                    </ListItemAvatar>
                    <ListItemText
                      primary={`Frame ${posInCategory + 1}`}
                      secondary={`Position: (${patch.x}, ${patch.y}) — Size: ${patch.width}x${patch.height}`}
                    />
                    <ListItemSecondaryAction>
                      <Tooltip title="Move up">
                        <span>
                          <IconButton
                            size="small"
                            onClick={() => handleMovePatch(globalIndex, 'up')}
                            disabled={posInCategory === 0}
                          >
                            <ArrowUpwardIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="Move down">
                        <span>
                          <IconButton
                            size="small"
                            onClick={() => handleMovePatch(globalIndex, 'down')}
                            disabled={posInCategory === getPatchesForCategory(selectedCategory).length - 1}
                          >
                            <ArrowDownwardIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="Delete">
                        <IconButton
                          size="small"
                          onClick={() => handleDeletePatch(globalIndex)}
                          color="error"
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </ListItemSecondaryAction>
                  </ListItem>
                ))}
              </List>
            )}
          </Box>
        )}

        {/* Step 3: Preview */}
        {activeStep === 2 && (
          <Box sx={{ display: 'flex', gap: 4, alignItems: 'flex-start', minHeight: 300 }}>
            {poseConfig ? (
              <PreviewCanvas
                poseConfig={poseConfig}
                testMouth={testMouth}
                testLeftEye={testLeftEye}
                testRightEye={testRightEye}
                breathing={breathing}
              />
            ) : (
              <Box
                sx={{
                  width: PREVIEW_W,
                  height: PREVIEW_H,
                  flexShrink: 0,
                  border: '2px dashed',
                  borderColor: 'divider',
                  borderRadius: 2,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: 'grey.50',
                }}
              >
                <FaceIcon sx={{ fontSize: 80, color: 'grey.300' }} />
              </Box>
            )}

            <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Typography variant="h6">Preview</Typography>

              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <Typography variant="body2">
                  Left Eye: {getPatchesForCategory('left_eye').length} patch{getPatchesForCategory('left_eye').length !== 1 ? 'es' : ''}
                </Typography>
                <Typography variant="body2">
                  Right Eye: {getPatchesForCategory('right_eye').length} patch{getPatchesForCategory('right_eye').length !== 1 ? 'es' : ''}
                </Typography>
                <Typography variant="body2">
                  Mouth: {mouthCount} patch{mouthCount !== 1 ? 'es' : ''}
                </Typography>
              </Box>

              <FormControlLabel
                control={
                  <Switch
                    checked={testMouth}
                    onChange={(e) => setTestMouth(e.target.checked)}
                    disabled={mouthCount === 0}
                  />
                }
                label="Test mouth animation"
              />

              <FormControlLabel
                control={
                  <Switch
                    checked={testLeftEye}
                    onChange={(e) => setTestLeftEye(e.target.checked)}
                    disabled={getPatchesForCategory('left_eye').length === 0}
                  />
                }
                label="Test left eye (cycle patches)"
              />

              <FormControlLabel
                control={
                  <Switch
                    checked={testRightEye}
                    onChange={(e) => setTestRightEye(e.target.checked)}
                    disabled={getPatchesForCategory('right_eye').length === 0}
                  />
                }
                label="Test right eye (cycle patches)"
              />

              <FormControlLabel
                control={
                  <Switch
                    checked={breathing}
                    onChange={(e) => setBreathing(e.target.checked)}
                  />
                }
                label="Breathing animation"
              />

              {(getPatchesForCategory('left_eye').length > 0 || getPatchesForCategory('right_eye').length > 0) && !testLeftEye && !testRightEye && (
                <Typography variant="caption" color="text.secondary">
                  Blink animation runs automatically every 2-6 seconds.
                </Typography>
              )}
            </Box>
          </Box>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Box sx={{ flex: 1 }} />
        {activeStep > 0 && (
          <Button onClick={() => setActiveStep((s) => s - 1)}>Back</Button>
        )}
        {activeStep < 2 ? (
          <Button
            variant="contained"
            onClick={() => setActiveStep((s) => s + 1)}
            disabled={activeStep === 0 && !hasBase}
          >
            Next
          </Button>
        ) : (
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={!hasBase}
          >
            Save Pose
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
};
