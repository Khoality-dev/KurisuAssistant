/**
 * "Set up {name} in 3D" — the VRM character editor (#242).
 *
 * Built for people who have never animated anything: a live preview on the
 * left, and on the right five steps with presets instead of numbers —
 * her model, how she moves, feelings, reactions, framing — plus an optional
 * Fine-tune with every number and her own animations. Every choice saves by
 * itself (`useDebouncedAutosave`, 800 ms), and the preview shows it at once.
 *
 * Two kinds of write, kept apart. The choices go through
 * `PATCH /character-assets/{id}/character-config` with `vrm` minus `model`
 * and `clips`, which are the server's (it writes them in the upload's own
 * transaction and ignores them in a body). Files go through the upload and
 * delete routes, and what they return is folded into the editor at once, so
 * the preview and the next autosave both see the new model.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  LinearProgress,
  Paper,
  Slider,
  Snackbar,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  AccessibilityNew as FullBodyIcon,
  Animation as AnimationIcon,
  ArrowBack as BackIcon,
  Check as CheckIcon,
  CheckCircle as ReadyIcon,
  CloudDone as SavedIcon,
  DeleteOutline as DeleteIcon,
  ErrorOutline as ErrorIcon,
  ExpandLess,
  ExpandMore,
  Face as FaceIcon,
  Person as WaistIcon,
  PlayArrow as PlayIcon,
  Psychology as ThinkIcon,
  RecordVoiceOver as SpeakIcon,
  Sync as SavingIcon,
  SwapHoriz as ReplaceIcon,
  Upload as UploadIcon,
  ViewInAr as ModelIcon,
  WarningAmber as WarningIcon,
  WavingHand as WaveIcon,
} from '@mui/icons-material';
import { apiClient, CharacterUploadError } from '@kurisu/api';
import {
  BACKGROUNDS,
  FRAMINGS,
  MOVE_PRESETS,
  REACTION_RECIPES,
  STRENGTHS,
  VRM_EMOTIONS,
  applyMovePreset,
  completeVrmSettings,
  derivePreset,
  emotionAvailability,
  extrasOn,
  parseCharacterConfig,
  recipeOn,
  resetVrmChoices,
  setExtras,
  setRecipe,
  strengthOf,
  toggleIdleClip,
  withoutClip,
  type CharacterConfigDTO,
  type CharacterKind,
  type Persona,
  type VrmClipRef,
  type VrmEmotion,
  type VrmSettings,
} from '@kurisu/models';
import { useDebouncedAutosave } from '@kurisu/hooks';
import { VrmPreview, type VrmPreviewHandle } from './VrmPreview';
import {
  asUploadCode,
  capitalise,
  isCancelled,
  mb,
  modelFilename,
  modelMeta,
  modelStatus,
  stepSummaries,
  uploadErrorText,
  type UploadErrorCode,
} from './vrmSetupText';

type Section = 'model' | 'move' | 'feel' | 'react' | 'frame' | 'fine';

type Upload =
  | { phase: 'uploading' | 'checking'; filename: string; pct: number }
  | { phase: 'error'; filename: string; code: UploadErrorCode; maxBytes?: number; size?: number };

type Confirm =
  | { kind: 'removeModel' }
  | { kind: 'deleteClip'; clip: VrmClipRef }
  | { kind: 'unsaved' };

export interface VrmSetupDialogProps {
  open: boolean;
  persona: Persona;
  /** The persona's config as the caller last saw it; the editor keeps it current through `onCharacterChange`. */
  characterConfig: CharacterConfigDTO | null;
  onClose: () => void;
  /** Every config the server returned, so the persona dialog shows the truth when this one closes. */
  onCharacterChange: (config: CharacterConfigDTO) => void;
}

const secondsText = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** The server-owned fields stay out of a save: it replaces them with its own anyway. */
function choicesOf(vrm: VrmSettings): Omit<VrmSettings, 'model' | 'clips'> {
  const { model: _model, clips: _clips, ...choices } = vrm;
  return choices;
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

interface StepCardProps {
  n: string;
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

/** One step: a numbered header that says where it stands, and its choices when open. Outside the dialog so a re-render never remounts it mid-drag. */
const StepCard: React.FC<StepCardProps> = ({ n, title, summary, open, onToggle, children }) => (
  <Paper variant="outlined" sx={{ borderColor: open ? 'primary.light' : 'divider', overflow: 'hidden' }}>
    <ButtonBase onClick={onToggle} sx={{ width: '100%', display: 'flex', alignItems: 'center', gap: 1.5, px: 2, py: 1.5, textAlign: 'left' }}>
      <Box sx={{
        width: 26, height: 26, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 13, fontWeight: 600,
        bgcolor: open ? 'primary.main' : 'action.hover', color: open ? 'primary.contrastText' : 'text.secondary',
      }}>{n}</Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="subtitle2">{title}</Typography>
        <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{summary}</Typography>
      </Box>
      {open ? <ExpandLess color="action" /> : <ExpandMore color="action" />}
    </ButtonBase>
    <Collapse in={open} unmountOnExit>
      <Box sx={{ px: 2, pb: 2 }}>{children}</Box>
    </Collapse>
  </Paper>
);

const SwitchRow: React.FC<{ checked: boolean; onChange: () => void; title: string; note?: string; action?: React.ReactNode }> = ({ checked, onChange, title, note, action }) => (
  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
    <Switch checked={checked} onChange={onChange} size="small" />
    <Box sx={{ flex: 1, cursor: 'pointer' }} onClick={onChange}>
      <Typography variant="body2">{title}</Typography>
      {note && <Typography variant="caption" color="text.secondary">{note}</Typography>}
    </Box>
    {action}
  </Box>
);

const Label: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2, mb: 0.75, fontWeight: 600 }}>{children}</Typography>
);

export const VrmSetupDialog: React.FC<VrmSetupDialogProps> = ({ open, persona, characterConfig, onClose, onCharacterChange }) => {
  const name = persona.name;
  const [settings, setSettings] = useState<VrmSettings>(() => completeVrmSettings(parseCharacterConfig(characterConfig)?.vrm));
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [section, setSection] = useState<Section | null>('model');
  const [upload, setUpload] = useState<Upload | null>(null);
  const [clipBusy, setClipBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [previewEmotion, setPreviewEmotion] = useState<VrmEmotion>('neutral');
  const [dragOver, setDragOver] = useState(false);
  const previewRef = useRef<VrmPreviewHandle>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const clipInputRef = useRef<HTMLInputElement>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  /** The whole config as the server last returned it: what the persona dialog is told. */
  const configRef = useRef<CharacterConfigDTO | null>(characterConfig);
  const kind: CharacterKind = parseCharacterConfig(characterConfig)?.kind ?? 'vrm';

  const later = (fn: () => void, ms: number) => {
    timersRef.current.push(setTimeout(fn, ms));
  };

  // Reopening starts from what the persona holds now.
  useEffect(() => {
    if (!open) return;
    configRef.current = characterConfig;
    setSettings(completeVrmSettings(parseCharacterConfig(characterConfig)?.vrm));
    setSection('model');
    setUpload(null);
    setConfirm(null);
    setSpeaking(false);
    setThinking(false);
    // Only on open: the config the caller passes back is this editor's own echo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => () => {
    timersRef.current.forEach(clearTimeout);
    uploadAbortRef.current?.abort();
  }, []);

  const adopt = useCallback((config: CharacterConfigDTO | null | undefined) => {
    if (!config) return;
    configRef.current = config;
    onCharacterChange(config);
  }, [onCharacterChange]);

  const autosave = useDebouncedAutosave<VrmSettings>(async (vrm) => {
    const body = { kind, vrm: choicesOf(vrm) } as unknown as CharacterConfigDTO;
    const res = await apiClient.updateCharacterConfig(persona.id, body);
    adopt(res?.character_config);
    window.dispatchEvent(new CustomEvent('character-config-saved', { detail: { personaId: persona.id } }));
  }, 800);

  // A persona switched to 3D has no `vrm` member yet, and the server's own
  // default has no moves and no reactions: store the starting character the
  // editor shows, so the window and the editor agree from the first minute.
  useEffect(() => {
    if (!open || parseCharacterConfig(characterConfig)?.vrm) return;
    autosave.schedule(completeVrmSettings(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const update = (next: VrmSettings) => {
    setSettings(next);
    autosave.schedule(next);
  };
  const patch = <K extends keyof VrmSettings>(key: K, value: VrmSettings[K]) => update({ ...settingsRef.current, [key]: value });

  /** Take the server's model and clips from an upload's response, keep every local choice. */
  const foldFiles = (config: CharacterConfigDTO | null | undefined) => {
    const stored = parseCharacterConfig(config)?.vrm;
    if (!stored) return;
    setSettings((prev) => ({ ...prev, model: stored.model ?? null, clips: stored.clips ?? [] }));
    adopt(config);
  };

  /** Close only once every choice is saved; a failed save keeps the editor open and says so. */
  const handleClose = async () => {
    uploadAbortRef.current?.abort();
    if (await autosave.flush()) {
      onClose();
      return;
    }
    setConfirm({ kind: 'unsaved' });
  };

  // ─── Her model ───

  const uploadModel = async (file: File) => {
    const had = !!settingsRef.current.model;
    try {
      const usage = await apiClient.getCharacterUsage();
      if (file.size > usage.max_model_bytes) {
        setUpload({ phase: 'error', filename: file.name, code: 'too_large', maxBytes: usage.max_model_bytes, size: file.size });
        return;
      }
    } catch {
      // The server checks again; a failed look-ahead is not a reason to refuse.
    }
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    setSection('model');
    setUpload({ phase: 'uploading', filename: file.name, pct: 0 });
    try {
      const res = await apiClient.uploadCharacterModel(persona.id, file, {
        filename: file.name,
        signal: controller.signal,
        onProgress: (loaded, total) => {
          const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
          setUpload({ phase: pct >= 100 ? 'checking' : 'uploading', filename: file.name, pct });
        },
      });
      foldFiles(res.character_config);
      setUpload(null);
      setToast(had ? 'Model replaced. Every choice carried over.' : `Model uploaded. ${name} now appears in 3D.`);
    } catch (error) {
      const code = error instanceof CharacterUploadError ? asUploadCode(error.code) : 'unknown';
      if (controller.signal.aborted || isCancelled(code)) {
        setUpload(null);
        return;
      }
      setUpload({ phase: 'error', filename: file.name, code, size: file.size });
    } finally {
      if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
    }
  };

  const removeModel = async () => {
    try {
      await apiClient.deleteCharacterModel(persona.id);
      // Functional: a choice made while the DELETE was out must survive it.
      setSettings((prev) => ({ ...prev, model: null }));
      const parsed = parseCharacterConfig(configRef.current);
      if (parsed?.vrm) adopt({ ...(configRef.current as object), vrm: { ...parsed.vrm, model: null } } as CharacterConfigDTO);
      setToast('Model removed. Your choices stay for the next upload.');
    } catch {
      setToast('The model could not be removed. Try again.');
    }
  };

  // ─── Her own animations ───

  const uploadClip = async (file: File) => {
    setClipBusy(true);
    try {
      const clipName = stripExtension(file.name);
      const res = await apiClient.uploadCharacterClip(persona.id, file, { name: clipName, loop: false });
      const stored = parseCharacterConfig(res.character_config)?.vrm;
      const clips = stored?.clips ?? [...settingsRef.current.clips, res.clip];
      adopt(res.character_config);
      // A new animation plays while she waits, as the mockup promises.
      update(toggleIdleClip({ ...settingsRef.current, clips }, res.clip.id));
      setToast(`${clipName}.vrma uploaded. It now plays while she waits.`);
    } catch (error) {
      const code = error instanceof CharacterUploadError ? asUploadCode(error.code) : 'unknown';
      if (!isCancelled(code)) setToast(uploadErrorText(code, file.name)[1]);
    } finally {
      setClipBusy(false);
    }
  };

  const deleteClip = async (clip: VrmClipRef) => {
    // The server refuses to delete a clip something still names: unname it first.
    const next = withoutClip(settingsRef.current, clip.id);
    update(next);
    try {
      // Only once the server has stopped naming it: otherwise the DELETE is a 409.
      if (!(await autosave.flush())) {
        setToast(`${clip.name} was not deleted: the change could not be saved. Check the connection and try again.`);
        return;
      }
      await apiClient.deleteCharacterClip(persona.id, clip.id);
      setSettings((prev) => ({ ...prev, clips: prev.clips.filter((c) => c.id !== clip.id) }));
      const parsed = parseCharacterConfig(configRef.current);
      if (parsed?.vrm) {
        adopt({ ...(configRef.current as object), vrm: { ...parsed.vrm, clips: parsed.vrm.clips.filter((c) => c.id !== clip.id) } } as CharacterConfigDTO);
      }
    } catch (error) {
      const code = error instanceof CharacterUploadError ? asUploadCode(error.code) : 'unknown';
      if (!isCancelled(code)) setToast(uploadErrorText(code, clip.name)[1]);
    }
  };

  // ─── Preview ───

  const availability = emotionAvailability(settings.model?.expressions);
  const showEmotion = (e: VrmEmotion) => {
    const shown = availability[e] ? e : 'neutral';
    setPreviewEmotion(shown);
    previewRef.current?.showEmotion(shown);
  };
  const speakLine = () => {
    setSpeaking(true);
    setThinking(false);
    later(() => setSpeaking(false), 3200);
  };
  const toggleThink = () => {
    setSpeaking(false);
    setThinking((t) => !t);
  };
  const waveAtHer = () => {
    if (!recipeOn(settings.reactions, 'wave')) {
      setToast('Turn on “Waves back” under Reactions.');
      return;
    }
    previewRef.current?.gesture('wave');
  };

  const summaries = useMemo(() => stepSummaries(settings), [settings]);
  const preset = derivePreset(settings.idle);
  const statusChip = autosave.status === 'saving' || autosave.status === 'pending'
    ? <Chip size="small" variant="outlined" icon={<SavingIcon sx={{ fontSize: 16 }} />} label="Saving…" />
    : autosave.status === 'error'
      ? <Chip size="small" color="error" variant="outlined" icon={<ErrorIcon sx={{ fontSize: 16 }} />} label="Not saved — retrying on the next change" />
      : <Chip size="small" variant="outlined" icon={<SavedIcon sx={{ fontSize: 16 }} />} label="Saved" sx={{ color: 'text.secondary' }} />;

  const pickModel = () => modelInputRef.current?.click();
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void uploadModel(file);
  };

  const busy = upload?.phase === 'uploading' || upload?.phase === 'checking';

  // ─── Steps ───

  const toggleSection = (id: Section) => setSection((cur) => (cur === id ? null : id));

  const fineSlider = (label: string, value: number, min: number, max: number, step: number, text: string, onChange: (v: number) => void) => (
    <Box key={label} sx={{ mt: 1.5 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
        <Typography variant="body2">{label}</Typography>
        <Typography variant="body2" color="text.secondary">{text}</Typography>
      </Box>
      <Slider size="small" value={value} min={min} max={max} step={step} onChange={(_, v) => onChange(v as number)} />
    </Box>
  );

  const idle = settings.idle;
  const setIdle = (next: Partial<VrmSettings['idle']>) => patch('idle', { ...settings.idle, ...next });
  const setBlink = (key: 'blink_min_interval' | 'blink_max_interval', v: number) => {
    const blink = { ...idle.blink, [key]: v };
    // The soonest can never be later than the latest.
    if (key === 'blink_min_interval' && blink.blink_max_interval < v) blink.blink_max_interval = v;
    if (key === 'blink_max_interval' && blink.blink_min_interval > v) blink.blink_min_interval = v;
    setIdle({ blink });
  };

  const modelErr = upload?.phase === 'error' ? uploadErrorText(upload.code, upload.filename, { maxBytes: upload.maxBytes, size: upload.size }) : null;
  const status = settings.model ? modelStatus(settings.model) : null;

  const confirmView = (() => {
    if (!confirm) return null;
    if (confirm.kind === 'removeModel') {
      const m = settings.model;
      return {
        title: 'Remove the 3D model?',
        body: `${name} will show no character until you upload another. How she moves, her feelings, reactions and framing are kept.`,
        action: 'Remove model',
        lines: [
          { icon: <ModelIcon fontSize="small" color="error" />, text: m ? modelFilename(m) : 'model', size: m ? mb(m.bytes) : '' },
          { icon: <CheckIcon fontSize="small" color="success" />, text: 'Your choices stay', size: '' },
        ],
        run: removeModel,
      };
    }
    if (confirm.kind === 'unsaved') {
      return {
        title: 'Your last change isn’t saved',
        body: 'The server didn’t accept it — the connection may be down. Stay and press Done again once it is back, or leave and lose the change.',
        action: 'Leave without saving',
        lines: [] as { icon: React.ReactNode; text: string; size: string }[],
        run: async () => {
          autosave.cancel();
          onClose();
        },
      };
    }
    const clip = confirm.clip;
    return {
      title: `Delete ${clip.name}?`,
      body: 'It stops playing while she waits.',
      action: 'Delete animation',
      lines: [{ icon: <AnimationIcon fontSize="small" color="error" />, text: `${clip.name}.vrma`, size: mb(clip.bytes) }],
      run: () => deleteClip(clip),
    };
  })();

  return (
    <>
      <Dialog open={open} onClose={() => void handleClose()} fullScreen>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 1 }}>
          <IconButton size="small" onClick={() => void handleClose()} aria-label="Back to the persona">
            <BackIcon />
          </IconButton>
          <Typography variant="h6" sx={{ flex: 1 }}>Set up {name} in 3D</Typography>
          {statusChip}
          <Button variant="contained" onClick={() => void handleClose()}>Done</Button>
        </DialogTitle>
        <DialogContent dividers sx={{ p: 0, display: 'flex', minHeight: 0 }}>
          {/* Preview */}
          <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', borderRight: 1, borderColor: 'divider' }}>
            <Box
              sx={{ position: 'relative', flex: 1, minHeight: 320, bgcolor: settings.model ? settings.camera.background : 'background.default' }}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
            >
              {settings.model ? (
                <>
                  <VrmPreview ref={previewRef} settings={settings} speaking={speaking} thinking={thinking} />
                  <Chip
                    size="small"
                    icon={<ModelIcon sx={{ fontSize: 16 }} />}
                    label={`${modelFilename(settings.model)} · ${settings.model.spec_version ? `VRM ${settings.model.spec_version}` : 'VRM'}`}
                    sx={{ position: 'absolute', top: 12, left: 12, bgcolor: 'background.paper' }}
                  />
                </>
              ) : (
                <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 4 }}>
                  <ButtonBase
                    onClick={pickModel}
                    disabled={busy}
                    sx={{
                      flexDirection: 'column', gap: 1, p: 5, maxWidth: 420, borderRadius: 3, border: '2px dashed',
                      borderColor: dragOver ? 'primary.main' : 'divider', '&:hover': { borderColor: 'primary.main' },
                    }}
                  >
                    <ModelIcon sx={{ fontSize: 40, color: 'text.secondary' }} />
                    <Typography variant="subtitle1">Drop a .vrm file here</Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
                      Export it from VRoid Studio as VRM 1.0 or 0.x. {name} shows no character until a model is uploaded.
                    </Typography>
                    <Button variant="outlined" component="span" sx={{ mt: 1 }}>Choose file</Button>
                  </ButtonBase>
                </Box>
              )}
            </Box>
            {settings.model && (
              <Box sx={{ px: 2, py: 1.5, borderTop: 1, borderColor: 'divider' }}>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
                  <Button size="small" variant={speaking ? 'contained' : 'text'} startIcon={<SpeakIcon />} onClick={speakLine}>Speak a line</Button>
                  <Button size="small" variant={thinking ? 'contained' : 'text'} startIcon={<ThinkIcon />} onClick={toggleThink}>Think</Button>
                  <Button size="small" startIcon={<WaveIcon />} onClick={waveAtHer}>Wave at her</Button>
                  <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
                  <ToggleButtonGroup size="small" exclusive value={previewEmotion} onChange={(_, v) => v && showEmotion(v)}>
                    {VRM_EMOTIONS.map((e) => (
                      <ToggleButton key={e} value={e} sx={{ px: 1.25, py: 0.25, textTransform: 'none' }}>
                        <Tooltip title={availability[e] ? '' : 'Not in this model'}>
                          <span style={{ textDecoration: availability[e] ? 'none' : 'line-through', opacity: availability[e] ? 1 : 0.5 }}>{capitalise(e)}</span>
                        </Tooltip>
                      </ToggleButton>
                    ))}
                  </ToggleButtonGroup>
                </Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
                  Try things here. Every choice on the right saves by itself.
                </Typography>
              </Box>
            )}
          </Box>

          {/* Steps */}
          <Box sx={{ width: 440, flexShrink: 0, overflowY: 'auto', p: 2.5, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
            <Box sx={{ mb: 1 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Set up {name} in five steps</Typography>
              <Typography variant="body2" color="text.secondary">
                The defaults already look right. Change only what you want; the preview shows it at once.
              </Typography>
            </Box>

            <StepCard n="1" title="Her model" summary={summaries.model} open={section === 'model'} onToggle={() => toggleSection('model')}>
              {busy && upload && upload.phase !== 'error' && (
                <Box sx={{ mb: 1.5 }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Typography variant="body2">{upload.phase === 'checking' ? `Checking ${upload.filename}` : `Uploading ${upload.filename}`}</Typography>
                    <Typography variant="body2" color="text.secondary">{upload.pct}%</Typography>
                  </Box>
                  <LinearProgress variant={upload.phase === 'checking' ? 'indeterminate' : 'determinate'} value={upload.pct} sx={{ my: 0.75 }} />
                  <Typography variant="caption" color="text.secondary">
                    {settings.model ? 'The current model keeps showing until the new one is accepted.' : 'This takes a few seconds.'}
                  </Typography>
                </Box>
              )}
              {modelErr && (
                <Alert
                  severity="error"
                  sx={{ mb: 1.5 }}
                  action={(
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                      <Button size="small" color="inherit" onClick={pickModel}>Choose another file</Button>
                      <Button size="small" color="inherit" onClick={() => setUpload(null)}>Dismiss</Button>
                    </Box>
                  )}
                >
                  <Typography variant="subtitle2">{modelErr[0]}</Typography>
                  <Typography variant="body2">{modelErr[1]}</Typography>
                </Alert>
              )}
              {settings.model && status ? (
                <>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>{modelFilename(settings.model)}</Typography>
                  <Typography variant="caption" color="text.secondary">{modelMeta(settings.model)}</Typography>
                  <Alert
                    severity={status.ok ? 'success' : 'warning'}
                    icon={status.ok ? <ReadyIcon fontSize="small" /> : <WarningIcon fontSize="small" />}
                    sx={{ mt: 1 }}
                  >
                    {status.text}
                  </Alert>
                  <Box sx={{ display: 'flex', gap: 1, mt: 1.5 }}>
                    <Button size="small" variant="outlined" startIcon={<ReplaceIcon />} onClick={pickModel} disabled={busy}>Replace</Button>
                    <Box sx={{ flex: 1 }} />
                    <Button size="small" color="error" onClick={() => setConfirm({ kind: 'removeModel' })} disabled={busy}>Remove</Button>
                  </Box>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                    Replacing keeps every choice below.
                  </Typography>
                </>
              ) : !busy && (
                <>
                  <Typography variant="body2" color="text.secondary">
                    Make a character in VRoid Studio (free), export it as .vrm, and upload it here. Everything below is already set up.
                  </Typography>
                  <Button variant="contained" startIcon={<UploadIcon />} onClick={pickModel} sx={{ mt: 1.5 }}>Upload .vrm</Button>
                </>
              )}
            </StepCard>

            <StepCard n="2" title="How she moves" summary={summaries.move} open={section === 'move'} onToggle={() => toggleSection('move')}>
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
                {MOVE_PRESETS.map((p) => {
                  const selected = preset === p.id;
                  return (
                    <ButtonBase
                      key={p.id}
                      onClick={() => patch('idle', applyMovePreset(settings.idle, p.id))}
                      sx={{
                        display: 'block', textAlign: 'left', p: 1.5, borderRadius: 1.5, border: 1,
                        borderColor: selected ? 'primary.main' : 'divider', bgcolor: selected ? 'action.selected' : 'transparent',
                      }}
                    >
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>{p.label}</Typography>
                      <Typography variant="caption" color="text.secondary">{p.sub}</Typography>
                    </ButtonBase>
                  );
                })}
              </Box>
              {preset === 'custom' && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                  You changed the details under Fine-tune. Pick one above to go back to a preset.
                </Typography>
              )}
              {preset !== 'still' && (
                <Box sx={{ mt: 1.5 }}>
                  <SwitchRow
                    checked={extrasOn(settings.idle)}
                    onChange={() => patch('idle', setExtras(settings.idle, !extrasOn(settings.idle)))}
                    title="Stretches and looks around now and then"
                    note="Short moves while she waits for you."
                  />
                </Box>
              )}
            </StepCard>

            <StepCard n="3" title="Feelings" summary={summaries.feel} open={section === 'feel'} onToggle={() => toggleSection('feel')}>
              <SwitchRow
                checked={settings.emotion.enabled}
                onChange={() => patch('emotion', { ...settings.emotion, enabled: !settings.emotion.enabled })}
                title="Show feelings while she talks"
                note="Her face follows what she’s saying: a smile for good news, a frown when something’s wrong."
              />
              <Label>Her usual face</Label>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                {VRM_EMOTIONS.map((e) => (
                  <Chip
                    key={e}
                    label={capitalise(e)}
                    size="small"
                    color={settings.emotion.default_expression === e ? 'primary' : 'default'}
                    variant={settings.emotion.default_expression === e ? 'filled' : 'outlined'}
                    onClick={() => {
                      patch('emotion', { ...settings.emotion, default_expression: e });
                      showEmotion(e);
                    }}
                  />
                ))}
              </Box>
              <Label>How strong</Label>
              <ToggleButtonGroup
                size="small"
                exclusive
                fullWidth
                value={strengthOf(settings.emotion.intensity)}
                onChange={(_, v) => {
                  const s = STRENGTHS.find((x) => x.id === v);
                  if (!s) return;
                  patch('emotion', { ...settings.emotion, intensity: s.intensity });
                  showEmotion('happy');
                  later(() => showEmotion(settingsRef.current.emotion.default_expression), 1800);
                }}
              >
                {STRENGTHS.map((s) => <ToggleButton key={s.id} value={s.id} sx={{ textTransform: 'none' }}>{s.label}</ToggleButton>)}
              </ToggleButtonGroup>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                Try each face with the buttons under the preview.
              </Typography>
            </StepCard>

            <StepCard n="4" title="Reactions" summary={summaries.react} open={section === 'react'} onToggle={() => toggleSection('react')}>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Little things she does on her own. Turn on the ones you like and press Try to see them.
              </Typography>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {REACTION_RECIPES.map((r) => (
                  <SwitchRow
                    key={r.id}
                    checked={recipeOn(settings.reactions, r.id)}
                    onChange={() => patch('reactions', setRecipe(settings.reactions, r.id, !recipeOn(settings.reactions, r.id)))}
                    title={r.label}
                    note={r.usesCamera ? 'Uses the camera' : 'While she works on an answer'}
                    action={(
                      <Button size="small" startIcon={<PlayIcon />} disabled={!settings.model} onClick={() => previewRef.current?.trigger(r.reaction.play)}>
                        Try
                      </Button>
                    )}
                  />
                ))}
              </Box>
            </StepCard>

            <StepCard n="5" title="Framing" summary={summaries.frame} open={section === 'frame'} onToggle={() => toggleSection('frame')}>
              <ToggleButtonGroup
                exclusive
                fullWidth
                size="small"
                value={settings.camera.target}
                onChange={(_, v) => v && patch('camera', { ...settings.camera, target: v })}
              >
                {FRAMINGS.map((f) => (
                  <ToggleButton key={f.target} value={f.target} sx={{ flexDirection: 'column', gap: 0.5, py: 1, textTransform: 'none' }}>
                    {f.target === 'head' ? <FaceIcon /> : f.target === 'upper_body' ? <WaistIcon /> : <FullBodyIcon />}
                    <Typography variant="caption">{f.label}</Typography>
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
              <Label>Background</Label>
              <Box sx={{ display: 'flex', gap: 1 }}>
                {BACKGROUNDS.map((b) => {
                  const selected = settings.camera.background.toLowerCase() === b.hex;
                  return (
                    <Tooltip key={b.hex} title={b.name}>
                      <ButtonBase
                        aria-label={b.name}
                        onClick={() => patch('camera', { ...settings.camera, background: b.hex })}
                        sx={{
                          width: 32, height: 32, borderRadius: '50%', bgcolor: b.hex,
                          border: selected ? '2px solid' : '1px solid', borderColor: selected ? 'primary.main' : 'divider',
                        }}
                      />
                    </Tooltip>
                  );
                })}
              </Box>
            </StepCard>

            <Divider sx={{ my: 0.5 }} />

            <StepCard n="+" title="Fine-tune (optional)" summary={summaries.fine} open={section === 'fine'} onToggle={() => toggleSection('fine')}>
              <Typography variant="body2" color="text.secondary">
                Exact numbers and your own animations. Most people never need this page.
              </Typography>
              {fineSlider('Breathing speed', idle.breath_period_ms, 2000, 8000, 250, `every ${secondsText(idle.breath_period_ms)}`, (v) => setIdle({ breath_period_ms: v }))}
              {fineSlider('Breathing depth', idle.breath_amplitude_deg, 0, 6, 0.5, `${idle.breath_amplitude_deg}°`, (v) => setIdle({ breath_amplitude_deg: v }))}
              {fineSlider('Sway', idle.sway_amplitude_deg, 0, 5, 0.5, `${idle.sway_amplitude_deg}°`, (v) => setIdle({ sway_amplitude_deg: v }))}
              {fineSlider('Blinks at the soonest', idle.blink.blink_min_interval, 500, 6000, 250, secondsText(idle.blink.blink_min_interval), (v) => setBlink('blink_min_interval', v))}
              {fineSlider('Blinks at the latest', idle.blink.blink_max_interval, 1000, 12000, 250, secondsText(idle.blink.blink_max_interval), (v) => setBlink('blink_max_interval', v))}
              {fineSlider('Face change speed', settings.emotion.attack_ms, 0, 1000, 20, `${settings.emotion.attack_ms} ms`, (v) => patch('emotion', { ...settings.emotion, attack_ms: v }))}
              <Label>Eyes look at</Label>
              <ToggleButtonGroup exclusive fullWidth size="small" value={idle.look_at} onChange={(_, v) => v && setIdle({ look_at: v })}>
                <ToggleButton value="camera" sx={{ textTransform: 'none' }}>You</ToggleButton>
                <ToggleButton value="drift" sx={{ textTransform: 'none' }}>Around the room</ToggleButton>
                <ToggleButton value="off" sx={{ textTransform: 'none' }}>Straight ahead</ToggleButton>
              </ToggleButtonGroup>

              <Divider sx={{ my: 2 }} />
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>Your own animations</Typography>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={clipBusy ? <CircularProgress size={14} /> : <UploadIcon />}
                  disabled={clipBusy}
                  onClick={() => clipInputRef.current?.click()}
                >
                  Upload .vrma
                </Button>
              </Box>
              {settings.clips.length === 0 ? (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                  None yet. Built-in moves already cover waving, nodding, thinking, stretching and looking around.
                </Typography>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mt: 1 }}>
                  {settings.clips.map((c) => {
                    const idleOn = settings.idle.idle_clip_ids.includes(c.id);
                    return (
                      <Box key={c.id} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Tooltip title="Play in the preview">
                          <span>
                            <IconButton size="small" disabled={!settings.model} onClick={() => previewRef.current?.trigger({ type: 'clip', clip_id: c.id })}>
                              <PlayIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Typography variant="body2" noWrap>{c.name}</Typography>
                          <Typography variant="caption" color="text.secondary">{mb(c.bytes)}</Typography>
                        </Box>
                        <Chip
                          size="small"
                          label="Plays while idle"
                          color={idleOn ? 'primary' : 'default'}
                          variant={idleOn ? 'filled' : 'outlined'}
                          onClick={() => update(toggleIdleClip(settingsRef.current, c.id))}
                        />
                        <Tooltip title="Delete">
                          <IconButton size="small" onClick={() => setConfirm({ kind: 'deleteClip', clip: c })}>
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Box>
                    );
                  })}
                </Box>
              )}
              <Button
                fullWidth
                variant="outlined"
                sx={{ mt: 2 }}
                onClick={() => {
                  update(resetVrmChoices(settingsRef.current));
                  setToast('Back to the defaults. Your own animations are kept.');
                }}
              >
                Put everything back to the defaults
              </Button>
            </StepCard>
          </Box>
        </DialogContent>
      </Dialog>

      <input
        ref={modelInputRef}
        type="file"
        accept=".vrm"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void uploadModel(file);
        }}
      />
      <input
        ref={clipInputRef}
        type="file"
        accept=".vrma"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void uploadClip(file);
        }}
      />

      <Dialog open={!!confirmView} onClose={() => setConfirm(null)} maxWidth="xs" fullWidth>
        {confirmView && (
          <>
            <DialogTitle>{confirmView.title}</DialogTitle>
            <DialogContent>
              <Typography variant="body2" sx={{ mb: 2 }}>{confirmView.body}</Typography>
              {confirmView.lines.length > 0 && <Paper variant="outlined" sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
                {confirmView.lines.map((l: { icon: React.ReactNode; text: string; size: string }) => (
                  <Box key={l.text} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    {l.icon}
                    <Typography variant="body2" sx={{ flex: 1 }}>{l.text}</Typography>
                    <Typography variant="caption" color="text.secondary">{l.size}</Typography>
                  </Box>
                ))}
              </Paper>}
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setConfirm(null)}>{confirm?.kind === 'unsaved' ? 'Stay' : 'Cancel'}</Button>
              <Button
                variant="contained"
                color="error"
                onClick={() => {
                  const run = confirmView.run;
                  setConfirm(null);
                  void run();
                }}
              >
                {confirmView.action}
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>

      <Snackbar open={!!toast} autoHideDuration={2800} onClose={() => setToast(null)} message={toast ?? ''} />
    </>
  );
};
