import React, { useRef, useState } from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Switch,
  FormControlLabel,
  Avatar,
} from '@mui/material';
import {
  Save as SaveIcon,
  SmartToy as AgentIcon,
  PhotoCamera as PhotoCameraIcon,
} from '@mui/icons-material';
import { ModelPicker } from '../ModelPicker';
import { ToolGroupChecklist } from './ToolGroupChecklist';
import type { ToolGroup } from './ToolGroupChecklist';
import { apiClient } from '../../api/client';

interface AgentFormData {
  name: string;
  description: string;
  system_prompt: string;
  model_name: string;
  think: boolean;
  available_tools: string[] | null;
  memory: string;
  memory_enabled: boolean;
  use_deferred_tools: boolean;
  agent_type: 'main' | 'sub';
  voice_reference: string | null;
  avatar_uuid: string | null;
  preferred_name: string | null;
  trigger_word: string | null;
}

interface AgentEditDialogProps {
  open: boolean;
  onClose: () => void;
  formData: AgentFormData;
  setFormData: React.Dispatch<React.SetStateAction<AgentFormData>>;
  isSystemAgent: boolean;
  models: Array<{ name: string; provider: string }>;
  toolGroups: ToolGroup[];
  onSave: () => void;
  onRefreshModels: () => Promise<void>;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
}

export const AgentEditDialog: React.FC<AgentEditDialogProps> = ({
  open,
  onClose,
  formData,
  setFormData,
  isSystemAgent,
  models,
  toolGroups,
  onSave,
  onRefreshModels,
  onSuccess,
  onError,
}) => {
  const isSub = formData.agent_type === 'sub';
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  const handleAvatarClick = () => {
    if (uploadingAvatar) return;
    fileInputRef.current?.click();
  };

  const handleAvatarFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      setUploadingAvatar(true);
      const { image_uuid } = await apiClient.uploadImage(file);
      setFormData((prev) => ({ ...prev, avatar_uuid: image_uuid }));
      onSuccess('Avatar uploaded.');
    } catch (err: any) {
      onError(err?.response?.data?.detail || err?.message || 'Failed to upload avatar.');
    } finally {
      setUploadingAvatar(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 2 }}>
        <span>Edit {isSub ? 'Sub-Agent' : 'Main Agent'}</span>
        {isSystemAgent && (
          <Typography variant="caption" color="text.secondary">System</Typography>
        )}
      </DialogTitle>

      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, mt: 1 }}>
          {!isSub && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 0.5 }}>
              <Box
                onClick={handleAvatarClick}
                sx={{
                  position: 'relative',
                  width: 96,
                  height: 96,
                  borderRadius: '50%',
                  cursor: uploadingAvatar ? 'progress' : 'pointer',
                  '&:hover .avatar-overlay': { opacity: 1 },
                }}
              >
                <Avatar
                  src={formData.avatar_uuid ? apiClient.getImageUrl(formData.avatar_uuid) : undefined}
                  sx={{
                    width: 96,
                    height: 96,
                    bgcolor: (t) => (t.palette.mode === 'light' ? '#F3F4F6' : '#262626'),
                  }}
                >
                  {!formData.avatar_uuid && (
                    <AgentIcon sx={{ fontSize: 40, color: 'text.secondary' }} />
                  )}
                </Avatar>
                <Box
                  className="avatar-overlay"
                  sx={{
                    position: 'absolute',
                    inset: 0,
                    borderRadius: '50%',
                    bgcolor: 'rgba(0, 0, 0, 0.45)',
                    color: 'white',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: uploadingAvatar ? 1 : 0,
                    transition: 'opacity 150ms ease',
                    pointerEvents: 'none',
                  }}
                >
                  <PhotoCameraIcon fontSize="small" />
                </Box>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={handleAvatarFileChange}
                />
              </Box>
            </Box>
          )}

          <TextField
            label="Name"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            fullWidth
            required
          />

          {!isSub && (
            <TextField
              label="Trigger word"
              value={formData.trigger_word || ''}
              onChange={(e) => setFormData({ ...formData, trigger_word: e.target.value || null })}
              fullWidth
              helperText="Picked when the first message of a new conversation contains this word."
            />
          )}

          <TextField
            label={isSub ? 'Task instructions' : 'System prompt'}
            value={isSystemAgent ? 'System-managed prompt' : formData.system_prompt}
            onChange={(e) => setFormData({ ...formData, system_prompt: e.target.value })}
            multiline
            minRows={6}
            maxRows={16}
            fullWidth
            disabled={isSystemAgent}
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
            value={formData.model_name}
            models={models}
            onChange={(model_name) => setFormData({ ...formData, model_name })}
            onRefresh={onRefreshModels}
            onSuccess={onSuccess}
            onError={onError}
            required
          />

          <Box>
            <Typography variant="body2" sx={{ mb: 1, fontWeight: 500 }}>Tools</Typography>
            <ToolGroupChecklist
              groups={toolGroups}
              enabledTools={formData.available_tools}
              onChange={(enabled) => setFormData({ ...formData, available_tools: enabled })}
            />
          </Box>

          <Box sx={{ display: 'flex', flexDirection: 'column' }}>
            <FormControlLabel
              control={
                <Switch
                  checked={formData.think}
                  onChange={(e) => setFormData({ ...formData, think: e.target.checked })}
                />
              }
              label="Extended thinking"
            />
            <FormControlLabel
              control={
                <Switch
                  checked={formData.use_deferred_tools}
                  onChange={(e) => setFormData({ ...formData, use_deferred_tools: e.target.checked })}
                />
              }
              label="Deferred tools"
            />
            <FormControlLabel
              control={
                <Switch
                  checked={formData.memory_enabled}
                  onChange={(e) => setFormData({ ...formData, memory_enabled: e.target.checked })}
                />
              }
              label="Memory"
            />
          </Box>

          {formData.memory_enabled && (
            <TextField
              label="Memory notes"
              value={formData.memory}
              onChange={(e) => setFormData({ ...formData, memory: e.target.value })}
              multiline
              minRows={4}
              maxRows={10}
              fullWidth
              placeholder="No memories yet. Auto-built from conversations — you can also edit manually."
            />
          )}
        </Box>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          startIcon={<SaveIcon />}
          onClick={onSave}
          disabled={!formData.name.trim() || !formData.model_name.trim()}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
};
