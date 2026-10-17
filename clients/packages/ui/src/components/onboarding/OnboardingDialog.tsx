import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Avatar,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  Radio,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { CheckCircle, PlayCircleOutline, ViewInAr } from '@mui/icons-material';
import type { VoiceInfo } from '@kurisu/models';
import { apiClient, describeRequestFailure } from '@kurisu/api';
import {
  ONBOARDING_PROVIDERS,
  OnboardingRun,
  connectProvider,
  defaultWakeWord,
  onboardingSteps,
  skipOnboarding,
  type FinishPart,
  type OnboardingModel,
  type OnboardingProvider,
  type OnboardingStep,
} from '@kurisu/state';

const STEP_TITLES: Record<OnboardingStep, string> = {
  model: 'Model',
  persona: 'Persona',
  voice: 'Voice',
  character: 'Character',
  wakeWord: 'Wake word',
};

const PART_LABELS: Record<Exclude<FinishPart, 'done'>, string> = {
  persona: 'Persona and voice',
  character: 'Uploading the 3D model',
  assistant: 'Model, persona in use and wake word',
};

/**
 * A new account's onboarding (#342): the model, an optional first persona with
 * its voice and character, and the wake word. Shown by `OnboardingGate` before
 * the main layout mounts, so the chat opens on what was chosen. The rules —
 * which steps apply, what finishing writes and in what order, a retry that
 * goes on from where it stopped — are `@kurisu/state`'s `onboarding.ts`, which
 * Android mirrors.
 */
export const OnboardingDialog: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const [withPersona, setWithPersona] = useState(true);
  const steps = onboardingSteps(withPersona);
  const [index, setIndex] = useState(0);
  const step = steps[Math.min(index, steps.length - 1)];

  // Model
  const [provider, setProvider] = useState<OnboardingProvider>('ollama');
  const [providerValue, setProviderValue] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [models, setModels] = useState<OnboardingModel[]>([]);
  const [providerProblem, setProviderProblem] = useState<string | null>(null);
  const [model, setModel] = useState<OnboardingModel | null>(null);

  // Persona
  const [name, setName] = useState('');
  const [preferredName, setPreferredName] = useState('');
  const [avatarUuid, setAvatarUuid] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const avatarInput = useRef<HTMLInputElement>(null);

  // Voice and character
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [voice, setVoice] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [vrmFile, setVrmFile] = useState<File | null>(null);
  const [wantsModel, setWantsModel] = useState(true);
  const vrmInput = useRef<HTMLInputElement>(null);

  // Wake word: starts as the persona's name until the user types one.
  const [wakeWord, setWakeWord] = useState('');
  const [wakeTouched, setWakeTouched] = useState(false);

  // Finishing
  const run = useMemo(() => new OnboardingRun(apiClient), []);
  const [finishing, setFinishing] = useState(false);
  const [part, setPart] = useState<FinishPart | null>(null);
  const [uploadFraction, setUploadFraction] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmSkip, setConfirmSkip] = useState(false);

  useEffect(() => {
    // A provider set up earlier (on another device, say) is already connected.
    apiClient.getModelsWithStatus()
      .then(({ models: found }) => {
        if (found.length === 0) return;
        setModels(found);
        setProvider((found[0].provider as OnboardingProvider) ?? 'ollama');
        setModel(found[0]);
      })
      .catch(() => { /* nothing connected yet */ });
    apiClient.listVoices().then(setVoices).catch(() => setVoices([]));
  }, []);

  useEffect(() => {
    if (step === 'wakeWord' && !wakeTouched) setWakeWord(defaultWakeWord(withPersona ? name : null));
  }, [step, wakeTouched, withPersona, name]);

  const providerEntry = ONBOARDING_PROVIDERS.find((p) => p.id === provider)!;
  const visibleModels = models.filter((m) => m.provider === provider);
  const canGoOn =
    (step !== 'persona' || !withPersona || name.trim().length > 0) &&
    (step !== 'character' || !wantsModel || vrmFile !== null);
  const isLast = index >= steps.length - 1;

  const connect = async () => {
    setConnecting(true);
    setProviderProblem(null);
    try {
      const result = await connectProvider(apiClient, provider, providerValue);
      setModels((prev) => [...prev.filter((m) => m.provider !== provider), ...result.models]);
      setProviderProblem(result.problem);
      if (result.models.length > 0) setModel(result.models[0]);
    } catch (e) {
      setProviderProblem(describeRequestFailure(e, 'Could not connect to that provider.'));
    } finally {
      setConnecting(false);
    }
  };

  const pickAvatar = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadingAvatar(true);
    try {
      setAvatarUuid((await apiClient.uploadImage(file)).image_uuid);
    } catch (err) {
      setError(describeRequestFailure(err, 'Failed to upload the picture.'));
    } finally {
      setUploadingAvatar(false);
    }
  };

  const preview = async (voiceId: string) => {
    setPreviewing(voiceId);
    try {
      const blob = await apiClient.synthesize(`Hello. This is ${name.trim() || 'your assistant'}.`, voiceId);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch (err) {
      setError(describeRequestFailure(err, 'That voice could not be played.'));
    } finally {
      setPreviewing(null);
    }
  };

  const finish = async () => {
    setFinishing(true);
    setError(null);
    try {
      await run.finish(
        {
          model,
          persona: withPersona
            ? { name, preferredName, avatarUuid, voice, vrmFile: wantsModel ? vrmFile : null }
            : null,
          wakeWord,
        },
        setPart,
        (loaded, total) => setUploadFraction(total > 0 ? loaded / total : null),
      );
      onDone();
    } catch (e) {
      setError(describeRequestFailure(e, 'Setting up did not finish.'));
    }
  };

  const skip = async () => {
    try {
      await skipOnboarding(apiClient);
    } finally {
      onDone();
    }
  };

  const summary = [
    model ? model.name : 'No model yet',
    withPersona ? (voice ? voices.find((v) => v.id === voice)?.name ?? voice : 'No voice') : 'No persona',
    withPersona ? (wantsModel && vrmFile ? '3D model' : 'No character yet') : null,
  ].filter(Boolean).join(' · ');

  if (finishing) {
    const parts = (Object.keys(PART_LABELS) as Array<keyof typeof PART_LABELS>).filter(
      (p) => (p !== 'persona' && p !== 'character') || (withPersona && (p === 'persona' || (wantsModel && vrmFile))),
    );
    const at = part ? parts.indexOf(part as keyof typeof PART_LABELS) : -1;
    return (
      <Dialog open maxWidth="xs" fullWidth aria-labelledby="onboarding-finishing">
        <DialogTitle id="onboarding-finishing">{withPersona ? `Setting up ${name.trim()}` : 'Setting up the assistant'}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5}>
            {parts.map((p, i) => (
              <Stack key={p} direction="row" spacing={1.5} alignItems="center">
                {i < at || part === 'done' ? (
                  <CheckCircle fontSize="small" color="success" />
                ) : i === at && !error ? (
                  <CircularProgress size={18} />
                ) : (
                  <Box sx={{ width: 20, height: 20, borderRadius: '50%', border: 1, borderColor: 'divider' }} />
                )}
                <Box sx={{ flex: 1 }}>
                  <Typography variant="body1">{PART_LABELS[p]}</Typography>
                  {p === 'character' && i === at && uploadFraction !== null && !error && (
                    <LinearProgress variant="determinate" value={uploadFraction * 100} sx={{ mt: 0.5 }} />
                  )}
                </Box>
              </Stack>
            ))}
            {error && <Typography color="error" variant="body2">{error}</Typography>}
          </Stack>
        </DialogContent>
        {error && (
          <DialogActions>
            <Button onClick={() => { setFinishing(false); setError(null); }}>Back</Button>
            <Button variant="contained" onClick={() => void finish()}>Try again</Button>
          </DialogActions>
        )}
      </Dialog>
    );
  }

  return (
    <>
      <Dialog open maxWidth="sm" fullWidth aria-labelledby="onboarding-title">
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 3, pt: 2.5 }}>
          <Stack component="ol" direction="row" spacing={2} aria-label="Steps" sx={{ listStyle: 'none', m: 0, p: 0 }}>
            {steps.map((s, i) => (
              <Typography
                component="li"
                key={s}
                variant="body2"
                aria-current={i === index ? 'step' : undefined}
                sx={{ fontWeight: i === index ? 600 : 400, color: i <= index ? 'text.primary' : 'text.secondary' }}
              >
                {i + 1}. {STEP_TITLES[s]}
              </Typography>
            ))}
          </Stack>
          <Button size="small" color="secondary" onClick={() => setConfirmSkip(true)}>Skip</Button>
        </Stack>

        <DialogTitle id="onboarding-title" sx={{ pt: 3, pb: 0.5 }}>{STEP_TITLES[step]}</DialogTitle>
        <DialogContent sx={{ minHeight: 320 }}>
          {step === 'model' && (
            <Stack spacing={2}>
              <Typography variant="body1" color="text.secondary">
                One model answers for the assistant and every persona. You can change it later from the chat header.
              </Typography>
              <ToggleButtonGroup
                exclusive
                size="small"
                value={provider}
                onChange={(_, v) => { if (v) { setProvider(v); setProviderValue(''); setProviderProblem(null); } }}
                aria-label="Provider"
              >
                {ONBOARDING_PROVIDERS.map((p) => <ToggleButton key={p.id} value={p.id}>{p.label}</ToggleButton>)}
              </ToggleButtonGroup>
              <Stack direction="row" spacing={1} alignItems="flex-start">
                <TextField
                  fullWidth
                  size="small"
                  label={providerEntry.input}
                  type={provider === 'ollama' ? 'url' : 'password'}
                  placeholder={provider === 'ollama' ? 'http://192.168.1.20:11434' : undefined}
                  value={providerValue}
                  onChange={(e) => setProviderValue(e.target.value)}
                  helperText={
                    providerProblem
                      ?? (visibleModels.length > 0 ? `Connected · ${visibleModels.length} model${visibleModels.length === 1 ? '' : 's'}` : ' ')
                  }
                  error={!!providerProblem}
                />
                <Button variant="outlined" onClick={() => void connect()} disabled={connecting} sx={{ flexShrink: 0, height: 40 }}>
                  {connecting ? 'Connecting…' : 'Connect'}
                </Button>
              </Stack>
              <Stack role="radiogroup" aria-label="Models" spacing={0.5} sx={{ maxHeight: 220, overflowY: 'auto' }}>
                {visibleModels.map((m) => (
                  <Box
                    component="label"
                    key={`${m.provider}:${m.name}`}
                    sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, borderRadius: 1, cursor: 'pointer', bgcolor: model?.name === m.name ? 'action.selected' : undefined }}
                  >
                    <Radio size="small" checked={model?.name === m.name && model?.provider === m.provider} onChange={() => setModel(m)} />
                    <Typography variant="body1">{m.name}</Typography>
                  </Box>
                ))}
              </Stack>
            </Stack>
          )}

          {step === 'persona' && (
            <Stack spacing={1.5}>
              <Typography variant="body1" color="text.secondary">
                Optional. A persona gives the assistant a name, a voice and a face. You can add or change one later in Settings.
              </Typography>
              <Box component="label" sx={{ display: 'flex', gap: 1, p: 1.5, border: 1, borderColor: !withPersona ? 'text.primary' : 'divider', borderRadius: 1.5, cursor: 'pointer' }}>
                <Radio size="small" checked={!withPersona} onChange={() => setWithPersona(false)} inputProps={{ 'aria-label': 'No persona' }} />
                <Box>
                  <Typography variant="body1" fontWeight={600}>No persona</Typography>
                  <Typography variant="body2" color="text.secondary">Talk to the assistant itself. Voice and character are skipped.</Typography>
                </Box>
              </Box>
              <Box sx={{ p: 1.5, border: 1, borderColor: withPersona ? 'text.primary' : 'divider', borderRadius: 1.5 }}>
                <Box component="label" sx={{ display: 'flex', gap: 1, cursor: 'pointer' }}>
                  <Radio size="small" checked={withPersona} onChange={() => setWithPersona(true)} inputProps={{ 'aria-label': 'Create a persona' }} />
                  <Box>
                    <Typography variant="body1" fontWeight={600}>Create a persona</Typography>
                    <Typography variant="body2" color="text.secondary">Then pick its voice and character.</Typography>
                  </Box>
                </Box>
                {withPersona && (
                  <Stack direction="row" spacing={2.5} sx={{ pl: 5, pt: 1.5 }}>
                    <Stack alignItems="center" spacing={1}>
                      <Avatar src={avatarUuid ? apiClient.getImageUrl(avatarUuid) : undefined} sx={{ width: 72, height: 72 }} />
                      <Button size="small" variant="outlined" disabled={uploadingAvatar} onClick={() => avatarInput.current?.click()}>
                        {uploadingAvatar ? 'Uploading…' : 'Add picture'}
                      </Button>
                      <input ref={avatarInput} type="file" accept="image/*" hidden onChange={(e) => void pickAvatar(e)} />
                    </Stack>
                    <Stack spacing={2} sx={{ flex: 1 }}>
                      <TextField size="small" label="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                      <TextField
                        size="small"
                        label="Calls you"
                        placeholder="Your name, or a nickname"
                        helperText="Optional"
                        value={preferredName}
                        onChange={(e) => setPreferredName(e.target.value)}
                      />
                    </Stack>
                  </Stack>
                )}
              </Box>
            </Stack>
          )}

          {step === 'voice' && (
            <Stack spacing={1.5}>
              <Typography variant="body1" color="text.secondary">
                How {name.trim()} sounds when replies are read aloud and in voice mode.
              </Typography>
              <Stack role="radiogroup" aria-label="Voices" spacing={0.5}>
                {[{ id: null as string | null, name: 'No voice', model: 'Text replies only' }, ...voices].map((v) => (
                  <Stack
                    key={v.id ?? 'none'}
                    direction="row"
                    alignItems="center"
                    sx={{ px: 1, borderRadius: 1, bgcolor: voice === v.id ? 'action.selected' : undefined }}
                  >
                    <Box component="label" sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, cursor: 'pointer' }}>
                      <Radio size="small" checked={voice === v.id} onChange={() => setVoice(v.id)} />
                      <Box>
                        <Typography variant="body1">{v.name || v.id}</Typography>
                        <Typography variant="body2" color="text.secondary">{v.model}</Typography>
                      </Box>
                    </Box>
                    {v.id && (
                      <IconButton aria-label={`Hear ${v.name || v.id}`} onClick={() => void preview(v.id!)} disabled={previewing !== null}>
                        {previewing === v.id ? <CircularProgress size={20} /> : <PlayCircleOutline />}
                      </IconButton>
                    )}
                  </Stack>
                ))}
              </Stack>
              {voices.length === 0 && (
                <Typography variant="body2" color="text.secondary">This server has no voices yet. You can pick one later in Settings.</Typography>
              )}
            </Stack>
          )}

          {step === 'character' && (
            <Stack spacing={1.5}>
              <Typography variant="body1" color="text.secondary">What {name.trim()} looks like beside the chat and in voice mode.</Typography>
              <Box sx={{ p: 1.5, border: 1, borderColor: wantsModel ? 'text.primary' : 'divider', borderRadius: 1.5 }}>
                <Box component="label" sx={{ display: 'flex', gap: 1, cursor: 'pointer' }}>
                  <Radio size="small" checked={wantsModel} onChange={() => setWantsModel(true)} inputProps={{ 'aria-label': '3D model' }} />
                  <Box>
                    <Typography variant="body1" fontWeight={600}>3D model</Typography>
                    <Typography variant="body2" color="text.secondary">A VRM file. It moves, blinks and lip-syncs while {name.trim()} speaks.</Typography>
                  </Box>
                </Box>
                {wantsModel && (
                  <Stack direction="row" spacing={1.5} alignItems="center" sx={{ pl: 5, pt: 1 }}>
                    <ViewInAr fontSize="small" color="action" />
                    <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
                      {vrmFile ? `${vrmFile.name} · ${(vrmFile.size / (1024 * 1024)).toFixed(1)} MB` : 'No file chosen'}
                    </Typography>
                    <Button size="small" variant="outlined" onClick={() => vrmInput.current?.click()}>{vrmFile ? 'Change' : 'Choose file'}</Button>
                    <input
                      ref={vrmInput}
                      type="file"
                      accept=".vrm"
                      hidden
                      aria-label="VRM file"
                      onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setVrmFile(f); }}
                    />
                  </Stack>
                )}
              </Box>
              <Box component="label" sx={{ display: 'flex', gap: 1, p: 1.5, border: 1, borderColor: !wantsModel ? 'text.primary' : 'divider', borderRadius: 1.5, cursor: 'pointer' }}>
                <Radio size="small" checked={!wantsModel} onChange={() => setWantsModel(false)} inputProps={{ 'aria-label': 'None for now' }} />
                <Box>
                  <Typography variant="body1" fontWeight={600}>None for now</Typography>
                  <Typography variant="body2" color="text.secondary">The picture from the persona step stands in.</Typography>
                </Box>
              </Box>
            </Stack>
          )}

          {step === 'wakeWord' && (
            <Stack spacing={2}>
              <Typography variant="body1" color="text.secondary">
                With voice mode on, saying it starts talking to {withPersona ? name.trim() : 'the assistant'}. Pick a word you don’t say often by accident.
              </Typography>
              <TextField
                size="small"
                label="Wake word"
                placeholder={withPersona ? undefined : 'e.g. Computer'}
                value={wakeWord}
                onChange={(e) => { setWakeTouched(true); setWakeWord(e.target.value); }}
                helperText={withPersona ? 'Starts as the persona’s name. Leave it empty for no wake word.' : 'Voice mode needs one. Leave it empty to set it later in Settings.'}
                sx={{ maxWidth: 320 }}
              />
              <Stack direction="row" spacing={2} alignItems="center" aria-label="Summary" sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: 1.5, bgcolor: 'background.default' }}>
                <Avatar src={withPersona && avatarUuid ? apiClient.getImageUrl(avatarUuid) : undefined}>
                  {(withPersona ? name.trim() : 'A').charAt(0).toUpperCase()}
                </Avatar>
                <Box>
                  <Typography variant="body1" fontWeight={600}>{withPersona ? name.trim() : 'The assistant'}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {summary} · {wakeWord.trim() ? `say “${wakeWord.trim()}” in voice mode` : 'no wake word yet'}
                  </Typography>
                </Box>
              </Stack>
            </Stack>
          )}
          {error && <Typography color="error" variant="body2" sx={{ mt: 2 }}>{error}</Typography>}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5, justifyContent: 'space-between' }}>
          <Button variant="outlined" disabled={index === 0} onClick={() => setIndex((i) => Math.max(0, i - 1))}>Back</Button>
          {isLast ? (
            <Button variant="contained" onClick={() => void finish()}>Start chatting</Button>
          ) : (
            <Button variant="contained" disabled={!canGoOn} onClick={() => { setError(null); setIndex((i) => i + 1); }}>Next</Button>
          )}
        </DialogActions>
      </Dialog>

      <Dialog open={confirmSkip} onClose={() => setConfirmSkip(false)} aria-labelledby="onboarding-skip">
        <DialogTitle id="onboarding-skip">Skip setup?</DialogTitle>
        <DialogContent>
          <Typography variant="body1">
            You’ll chat with the assistant itself, with no wake word. What you picked here isn’t saved, and this won’t come up again on any device. Personas are in Settings whenever you want one.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmSkip(false)}>Keep going</Button>
          <Button onClick={() => void skip()}>Skip</Button>
        </DialogActions>
      </Dialog>
    </>
  );
};
