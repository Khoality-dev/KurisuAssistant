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
import { Slider, Divider } from '@mui/material';
import { apiClient } from '../../api/client';
import { config } from '../../config';
import type { PatchInfo, PoseConfig, AnimationSettings } from '../../videocall/types';
import { PreviewCanvas, PREVIEW_W, PREVIEW_H } from './PreviewCanvas';
import { useAuthedAssetUrl } from '../../utils/authedAsset';

const STEPS = ['Base Image', 'Keyframes', 'Preview'];

const DEFAULT_ANIMATION_SETTINGS: AnimationSettings = {
  breathing_enabled: true,
  breathing_amplitude: 3,
  breathing_period: 3500,
  blink_min_interval: 2000,
  blink_max_interval: 6000,
  blink_close_duration: 100,
  blink_hold_duration: 50,
  blink_open_duration: 100,
};

type PatchCategory = 'left_eye' | 'right_eye' | 'mouth';

interface CategoryPatch extends PatchInfo {
  category: PatchCategory;
}

// ─── PoseNodeEditor sub-dialog ───

export interface PoseNodeEditorProps {
  open: boolean;
  agentId: number;
  poseId: string;
  initialPoseConfig: PoseConfig | null;
  initialAnimationSettings?: AnimationSettings;
  nodeName: string;
  onSave: (poseConfig: PoseConfig, name: string, animationSettings: AnimationSettings) => void;
  onClose: () => void;
}

export const PoseNodeEditor: React.FC<PoseNodeEditorProps> = ({
  open,
  agentId,
  poseId,
  initialPoseConfig,
  initialAnimationSettings,
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
  // Character assets need the auth header, so <img src> cannot load them directly.
  const displayBaseImageUrl = useAuthedAssetUrl(baseImageUrl);
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

  // Animation settings
  const [animSettings, setAnimSettings] = useState<AnimationSettings>({ ...DEFAULT_ANIMATION_SETTINGS });

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

    setAnimSettings({ ...DEFAULT_ANIMATION_SETTINGS, ...initialAnimationSettings });

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
      setPatches(existingPatches);
    } catch (err) {
      console.error('Failed to load pose config:', err);
    }
  };

  const buildPoseConfig = (): PoseConfig | null => {
    if (!hasBase) return null;

    const buildPatches = (category: PatchCategory) =>
      patches
        .filter((p) => p.category === category)
        .map(({ category: _cat, ...rest }) => rest);

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
    onSave(poseConfig, name || 'Untitled', animSettings);
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
              {displayBaseImageUrl ? (
                <Box
                  component="img"
                  src={displayBaseImageUrl}
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
                  Blink animation runs automatically.
                </Typography>
              )}

              <Divider sx={{ my: 1 }} />

              {/* Breathing settings */}
              <Typography variant="subtitle2" color="text.secondary">Breathing</Typography>
              <Typography variant="body2">Amplitude: {animSettings.breathing_amplitude} px</Typography>
              <Slider
                value={animSettings.breathing_amplitude}
                onChange={(_, v) => setAnimSettings((s) => ({ ...s, breathing_amplitude: v as number }))}
                min={0.5} max={10} step={0.5} size="small"
                disabled={!animSettings.breathing_enabled}
              />
              <Typography variant="body2">Period: {(animSettings.breathing_period / 1000).toFixed(1)} s</Typography>
              <Slider
                value={animSettings.breathing_period}
                onChange={(_, v) => setAnimSettings((s) => ({ ...s, breathing_period: v as number }))}
                min={1000} max={10000} step={100} size="small"
                disabled={!animSettings.breathing_enabled}
              />

              {/* Blink settings */}
              <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 1 }}>Blinking</Typography>
              <Typography variant="body2">
                Interval: {(animSettings.blink_min_interval / 1000).toFixed(1)}–{(animSettings.blink_max_interval / 1000).toFixed(1)} s
              </Typography>
              <Slider
                value={[animSettings.blink_min_interval, animSettings.blink_max_interval]}
                onChange={(_, v) => {
                  const [min, max] = v as number[];
                  setAnimSettings((s) => ({ ...s, blink_min_interval: min, blink_max_interval: max }));
                }}
                min={500} max={15000} step={100} size="small" disableSwap
              />
              <Typography variant="body2">Close: {animSettings.blink_close_duration} ms</Typography>
              <Slider
                value={animSettings.blink_close_duration}
                onChange={(_, v) => setAnimSettings((s) => ({ ...s, blink_close_duration: v as number }))}
                min={20} max={500} step={10} size="small"
              />
              <Typography variant="body2">Hold: {animSettings.blink_hold_duration} ms</Typography>
              <Slider
                value={animSettings.blink_hold_duration}
                onChange={(_, v) => setAnimSettings((s) => ({ ...s, blink_hold_duration: v as number }))}
                min={10} max={300} step={5} size="small"
              />
              <Typography variant="body2">Open: {animSettings.blink_open_duration} ms</Typography>
              <Slider
                value={animSettings.blink_open_duration}
                onChange={(_, v) => setAnimSettings((s) => ({ ...s, blink_open_duration: v as number }))}
                min={20} max={500} step={10} size="small"
              />
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
