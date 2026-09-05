import React, { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { Save as SaveIcon } from '@mui/icons-material';
import { apiClient } from '../../api/client';
import type { SubAgent, SubAgentCreate, SubAgentUpdate } from '../../api/types';
import { ModelPicker } from '../ModelPicker';
import { ToolGroupChecklist } from './ToolGroupChecklist';
import type { ToolGroup } from './ToolGroupChecklist';

export interface SubAgentFormData {
  name: string;
  description: string;
  system_prompt: string;
  model_name: string;
  available_tools: string[] | null;
  think: boolean;
  use_deferred_tools: boolean;
}

const EMPTY_FORM: SubAgentFormData = {
  name: '',
  description: '',
  system_prompt: '',
  model_name: '',
  available_tools: null,
  think: false,
  use_deferred_tools: false,
};

function toForm(subAgent: SubAgent): SubAgentFormData {
  return {
    name: subAgent.name,
    description: subAgent.description || '',
    system_prompt: subAgent.system_prompt || '',
    model_name: subAgent.model_name || '',
    available_tools: subAgent.available_tools ?? null,
    think: subAgent.think,
    use_deferred_tools: subAgent.use_deferred_tools,
  };
}

interface SubAgentEditDialogProps {
  open: boolean;
  /** null creates a new sub-agent. */
  subAgent: SubAgent | null;
  models: Array<{ name: string; provider: string }>;
  toolGroups: ToolGroup[];
  onClose: () => void;
  onRefreshModels: () => Promise<void>;
  onSaved: (message: string) => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
}

/**
 * Create/edit one sub-agent. A sub-agent runs its own LLM loop, so it carries a
 * model and a tool set — but no identity: no avatar, no voice, no memory, and it
 * is never bound to a conversation or shown as the speaker.
 */
export const SubAgentEditDialog: React.FC<SubAgentEditDialogProps> = ({
  open,
  subAgent,
  models,
  toolGroups,
  onClose,
  onRefreshModels,
  onSaved,
  onSuccess,
  onError,
}) => {
  const isCreate = subAgent === null;
  const [form, setForm] = useState<SubAgentFormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(subAgent ? toForm(subAgent) : EMPTY_FORM);
  }, [open, subAgent]);

  const handleSave = async () => {
    const name = form.name.trim();
    if (!name) return;
    const modelName = form.model_name.trim();
    const provider = models.find((m) => m.name === modelName)?.provider || 'ollama';

    try {
      setSaving(true);
      if (isCreate) {
        const body: SubAgentCreate = {
          name,
          description: form.description || undefined,
          system_prompt: form.system_prompt || undefined,
          model_name: modelName || undefined,
          provider_type: modelName ? provider : undefined,
          available_tools: form.available_tools ?? undefined,
          think: form.think,
          use_deferred_tools: form.use_deferred_tools,
        };
        const created = await apiClient.createSubAgent(body);
        onSaved(`Sub-agent "${created.name}" created.`);
      } else {
        const saved = toForm(subAgent!);
        const body: SubAgentUpdate = {};
        if (name !== saved.name) body.name = name;
        if (form.description !== saved.description) body.description = form.description;
        if (form.system_prompt !== saved.system_prompt) body.system_prompt = form.system_prompt;
        if (modelName !== saved.model_name) {
          // null means "use the assistant's model".
          body.model_name = modelName || null;
          if (modelName) body.provider_type = provider;
        }
        if (JSON.stringify(form.available_tools) !== JSON.stringify(saved.available_tools)) {
          // null means every tool.
          body.available_tools = form.available_tools;
        }
        if (form.think !== saved.think) body.think = form.think;
        if (form.use_deferred_tools !== saved.use_deferred_tools) body.use_deferred_tools = form.use_deferred_tools;

        if (Object.keys(body).length > 0) {
          await apiClient.updateSubAgent(subAgent!.id, body);
        }
        onSaved(`Sub-agent "${name}" saved.`);
      }
      onClose();
    } catch (err: any) {
      onError(err?.response?.data?.detail || err?.message || 'Failed to save the sub-agent.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{isCreate ? 'New sub-agent' : `Edit ${subAgent!.name}`}</DialogTitle>

      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, mt: 1 }}>
          <TextField
            label="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            fullWidth
            required
            helperText="A skill, not a character — e.g. “Researcher”. It becomes the delegation tool's name."
          />

          <TextField
            label="Description"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            fullWidth
            helperText="Shown to the assistant when it decides whether to delegate."
          />

          <TextField
            label="Task instructions"
            value={form.system_prompt}
            onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
            multiline
            minRows={6}
            maxRows={16}
            fullWidth
            helperText="What this worker should do when it is called. No personality — just the task."
            InputProps={{
              sx: {
                alignItems: 'flex-start',
                '& textarea': {
                  fontFamily: '"Consolas", "SFMono-Regular", "Roboto Mono", monospace',
                  lineHeight: 1.6,
                },
              },
            }}
          />

          <ModelPicker
            label="Model"
            value={form.model_name}
            models={models}
            onChange={(model_name) => setForm({ ...form, model_name })}
            onRefresh={onRefreshModels}
            onSuccess={onSuccess}
            onError={onError}
            helperText="Leave empty to run on the assistant's model."
          />

          <Box>
            <Typography variant="body2" sx={{ mb: 1, fontWeight: 500 }}>Tools</Typography>
            <ToolGroupChecklist
              groups={toolGroups}
              enabledTools={form.available_tools}
              onChange={(available_tools) => setForm({ ...form, available_tools })}
            />
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
              A sub-agent's tool list is its own — it does not inherit the assistant's.
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
          </Box>
        </Box>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          startIcon={<SaveIcon />}
          onClick={handleSave}
          disabled={!form.name.trim() || saving}
        >
          {isCreate ? 'Create' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
