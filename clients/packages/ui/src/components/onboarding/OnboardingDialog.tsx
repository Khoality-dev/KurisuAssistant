import React, { useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { apiClient, describeRequestFailure } from '@kurisu/api';
import {
  ONBOARDING_PROVIDERS,
  connectProvider,
  finishOnboarding,
  skipOnboarding,
  type OnboardingModel,
  type OnboardingProvider,
} from '@kurisu/state';

/**
 * A new account's onboarding (#342): the model, and only the model (#376) —
 * once the assistant has one it can be asked for the rest. Shown by
 * `OnboardingGate` before the main layout mounts, so the chat opens on the
 * model chosen. The rules — what connecting saves, what finishing writes — are
 * `@kurisu/state`'s `onboarding.ts`, which Android mirrors.
 */
export const OnboardingDialog: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const [provider, setProvider] = useState<OnboardingProvider>('ollama');
  const [providerValue, setProviderValue] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [models, setModels] = useState<OnboardingModel[]>([]);
  const [providerProblem, setProviderProblem] = useState<string | null>(null);
  const [model, setModel] = useState<OnboardingModel | null>(null);
  const [finishing, setFinishing] = useState(false);
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
  }, []);

  const providerEntry = ONBOARDING_PROVIDERS.find((p) => p.id === provider)!;
  const visibleModels = models.filter((m) => m.provider === provider);
  const modelKey = (m: OnboardingModel) => `${m.provider}:${m.name}`;

  const pickProvider = (id: OnboardingProvider) => {
    setProvider(id);
    setProviderValue('');
    setProviderProblem(null);
    // Only a model of the provider shown is the one Start chatting saves.
    setModel(models.find((m) => m.provider === id) ?? null);
  };

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

  const finish = async () => {
    if (!model) return;
    setFinishing(true);
    setError(null);
    try {
      await finishOnboarding(apiClient, model);
      onDone();
    } catch (e) {
      setError(describeRequestFailure(e, 'The model was not saved.'));
      setFinishing(false);
    }
  };

  const skip = async () => {
    try {
      await skipOnboarding(apiClient);
    } finally {
      onDone();
    }
  };

  return (
    <>
      <Dialog open maxWidth="xs" fullWidth aria-labelledby="onboarding-title">
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ pr: 2 }}>
          <DialogTitle id="onboarding-title" sx={{ pb: 0.5 }}>Model</DialogTitle>
          <Button size="small" color="secondary" onClick={() => setConfirmSkip(true)}>Skip</Button>
        </Stack>
        <DialogContent>
          <Stack spacing={2.5}>
            <Typography variant="body1" color="text.secondary">
              One model answers for the assistant and every persona. You can change it later from the chat header.
            </Typography>
            <TextField
              select
              fullWidth
              size="small"
              label="Provider"
              value={provider}
              onChange={(e) => pickProvider(e.target.value as OnboardingProvider)}
            >
              {ONBOARDING_PROVIDERS.map((p) => <MenuItem key={p.id} value={p.id}>{p.label}</MenuItem>)}
            </TextField>
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
            <TextField
              select
              fullWidth
              size="small"
              label="Model"
              value={model ? modelKey(model) : ''}
              disabled={visibleModels.length === 0}
              onChange={(e) => setModel(visibleModels.find((m) => modelKey(m) === e.target.value) ?? null)}
            >
              {visibleModels.map((m) => <MenuItem key={modelKey(m)} value={modelKey(m)}>{m.name}</MenuItem>)}
            </TextField>
            {error && <Typography color="error" variant="body2">{error}</Typography>}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button variant="contained" disabled={!model || finishing} onClick={() => void finish()}>
            {finishing ? 'Saving…' : 'Start chatting'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={confirmSkip} onClose={() => setConfirmSkip(false)} aria-labelledby="onboarding-skip">
        <DialogTitle id="onboarding-skip">Skip setup?</DialogTitle>
        <DialogContent>
          <Typography variant="body1">
            The assistant needs a model before it can answer, so your first message will ask you to choose one. This won’t come up again on any device.
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
