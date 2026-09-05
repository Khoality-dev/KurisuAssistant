import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  FormControlLabel,
  MenuItem,
  Paper,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { Save as SaveIcon } from '@mui/icons-material';
import { apiClient } from '../../api/client';
import { usePersonaStore } from '../../store/personaStore';
import type { Assistant, AssistantUpdate } from '../../api/types';
import { ModelPicker } from '../ModelPicker';
import { ToolGroupChecklist } from './ToolGroupChecklist';
import { useAvailableTools } from './useAvailableTools';

interface AssistantFormData {
  model_name: string;
  available_tools: string[] | null;
  think: boolean;
  use_deferred_tools: boolean;
  memory: string;
  memory_enabled: boolean;
  trigger_word: string;
  default_persona_id: number | null;
}

function toForm(assistant: Assistant): AssistantFormData {
  return {
    model_name: assistant.model_name || '',
    available_tools: assistant.available_tools ?? null,
    think: assistant.think,
    use_deferred_tools: assistant.use_deferred_tools,
    memory: assistant.memory || '',
    memory_enabled: assistant.memory_enabled,
    trigger_word: assistant.trigger_word || '',
    default_persona_id: assistant.default_persona_id,
  };
}

/**
 * The user's single assistant: what it can do. One model, one tool set, one
 * memory, one wake word — created at registration, so there is nothing to add
 * or delete here. Personas change who answers; none of this changes with them.
 */
export const AssistantSection: React.FC = () => {
  const personas = usePersonaStore((s) => s.personas);
  const loadPersonas = usePersonaStore((s) => s.loadPersonas);

  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [form, setForm] = useState<AssistantFormData | null>(null);
  const [models, setModels] = useState<Array<{ name: string; provider: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const { toolGroups } = useAvailableTools(setError);

  const flash = (message: string) => {
    setSuccessMessage(message);
    setTimeout(() => setSuccessMessage(''), 3000);
  };

  const loadModels = async () => {
    try {
      setModels(await apiClient.getModels());
    } catch (err: any) {
      console.error('Failed to load models:', err);
      setError('Failed to load the model list');
    }
  };

  const loadAssistant = async () => {
    try {
      setLoading(true);
      const data = await apiClient.getAssistant();
      setAssistant(data);
      setForm(toForm(data));
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to load the assistant');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAssistant();
    void loadModels();
    if (personas.length === 0) void loadPersonas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = useMemo(() => {
    if (!assistant || !form) return false;
    const saved = toForm(assistant);
    return (
      saved.model_name !== form.model_name
      || saved.think !== form.think
      || saved.use_deferred_tools !== form.use_deferred_tools
      || saved.memory !== form.memory
      || saved.memory_enabled !== form.memory_enabled
      || saved.trigger_word !== form.trigger_word
      || saved.default_persona_id !== form.default_persona_id
      || JSON.stringify(saved.available_tools) !== JSON.stringify(form.available_tools)
    );
  }, [assistant, form]);

  const handleSave = async () => {
    if (!assistant || !form) return;
    const saved = toForm(assistant);
    const update: AssistantUpdate = {};

    const modelName = form.model_name.trim();
    if (modelName !== saved.model_name) {
      update.model_name = modelName || null;
      // The provider travels with the model: the picker lists both.
      update.provider_type = models.find((m) => m.name === modelName)?.provider || 'ollama';
    }
    if (JSON.stringify(form.available_tools) !== JSON.stringify(saved.available_tools)) {
      // `null` is the only way to say "every tool" again.
      update.available_tools = form.available_tools;
    }
    if (form.think !== saved.think) update.think = form.think;
    if (form.use_deferred_tools !== saved.use_deferred_tools) update.use_deferred_tools = form.use_deferred_tools;
    if (form.memory !== saved.memory) update.memory = form.memory || null;
    if (form.memory_enabled !== saved.memory_enabled) update.memory_enabled = form.memory_enabled;
    if (form.trigger_word !== saved.trigger_word) update.trigger_word = form.trigger_word.trim() || null;
    if (form.default_persona_id !== saved.default_persona_id) update.default_persona_id = form.default_persona_id;

    if (Object.keys(update).length === 0) return;

    try {
      setSaving(true);
      setError('');
      const next = await apiClient.updateAssistant(update);
      setAssistant(next);
      setForm(toForm(next));
      flash('Assistant saved.');
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to save the assistant');
    } finally {
      setSaving(false);
    }
  };

  if (loading || !form) {
    return (
      <Box>
        <Typography variant="h5" sx={{ mb: 3, fontWeight: 600 }}>Assistant</Typography>
        {error
          ? <Alert severity="error" onClose={() => setError('')}>{error}</Alert>
          : <Typography color="text.secondary">Loading assistant…</Typography>}
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto', pb: 4 }}>
      <Typography variant="h5" sx={{ mb: 0.5, fontWeight: 600 }}>Assistant</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        What your assistant can do: one model, one tool set, one memory. You have exactly one —
        it is created with your account. Personas change who answers, never any of this.
      </Typography>

      {successMessage && <Alert severity="success" sx={{ mb: 2 }}>{successMessage}</Alert>}
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

      <Paper elevation={0} sx={{ p: 3, border: '1px solid', borderColor: 'divider', display: 'flex', flexDirection: 'column', gap: 3 }}>
        <ModelPicker
          label="Model"
          value={form.model_name}
          models={models}
          onChange={(model_name) => setForm({ ...form, model_name })}
          onRefresh={loadModels}
          onSuccess={flash}
          onError={setError}
          helperText="The model every reply is generated with, whichever persona is answering."
        />

        <TextField
          label="Wake word"
          value={form.trigger_word}
          onChange={(e) => setForm({ ...form, trigger_word: e.target.value })}
          fullWidth
          helperText="Say this in voice mode to wake the assistant. It selects no persona — whichever persona the conversation is bound to answers."
        />

        <TextField
          select
          label="Default persona"
          value={form.default_persona_id ?? ''}
          onChange={(e) => setForm({
            ...form,
            default_persona_id: e.target.value === '' ? null : Number(e.target.value),
          })}
          fullWidth
          helperText="Every new conversation silently starts with this persona. You can switch it per conversation from the chat header."
        >
          {personas.length === 0 && <MenuItem value="">No personas yet</MenuItem>}
          {personas.map((p) => (
            <MenuItem key={p.id} value={p.id}>
              {p.name}{p.enabled ? '' : ' (disabled)'}
            </MenuItem>
          ))}
        </TextField>

        <Box>
          <Typography variant="body2" sx={{ mb: 1, fontWeight: 500 }}>Tools</Typography>
          <ToolGroupChecklist
            groups={toolGroups}
            enabledTools={form.available_tools}
            onChange={(available_tools) => setForm({ ...form, available_tools })}
          />
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
            All tools are enabled by default. Unchecking one hides it from every reply.
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column' }}>
          <FormControlLabel
            control={<Switch checked={form.think} onChange={(e) => setForm({ ...form, think: e.target.checked })} />}
            label="Extended thinking"
          />
          <FormControlLabel
            control={<Switch checked={form.use_deferred_tools} onChange={(e) => setForm({ ...form, use_deferred_tools: e.target.checked })} />}
            label="Deferred tools"
          />
          <Typography variant="caption" color="text.secondary" sx={{ ml: 6, mt: -0.5, mb: 1 }}>
            Load tool schemas on demand instead of sending them all up front. Smaller prompt, one extra round-trip.
          </Typography>
          <FormControlLabel
            control={<Switch checked={form.memory_enabled} onChange={(e) => setForm({ ...form, memory_enabled: e.target.checked })} />}
            label="Memory"
          />
        </Box>

        {form.memory_enabled && (
          <TextField
            label="Memory notes"
            value={form.memory}
            onChange={(e) => setForm({ ...form, memory: e.target.value })}
            multiline
            minRows={4}
            maxRows={12}
            fullWidth
            placeholder="No memories yet. Built automatically from your conversations — you can also edit them here."
            helperText="One memory for the whole assistant. Personas do not each keep their own."
          />
        )}

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
          <Button
            onClick={() => assistant && setForm(toForm(assistant))}
            disabled={!dirty || saving}
          >
            Revert
          </Button>
          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            onClick={handleSave}
            disabled={!dirty || saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </Box>
      </Paper>
    </Box>
  );
};
