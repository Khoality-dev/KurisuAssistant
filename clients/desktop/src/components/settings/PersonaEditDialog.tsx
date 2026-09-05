import React, { useEffect, useRef, useState } from 'react';
import {
  Avatar,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import {
  AccountCircle as PersonaIcon,
  PhotoCamera as PhotoCameraIcon,
  Save as SaveIcon,
  Videocam as CharacterIcon,
} from '@mui/icons-material';
import { apiClient } from '../../api/client';
import type { Persona, PersonaCreate, PersonaUpdate } from '../../api/types';
import { CharacterConfigDialog } from '../character/CharacterConfigDialog';

export interface PersonaFormData {
  name: string;
  description: string;
  system_prompt: string;
  preferred_name: string;
  voice_reference: string;
  avatar_uuid: string | null;
}

const EMPTY_FORM: PersonaFormData = {
  name: '',
  description: '',
  system_prompt: '',
  preferred_name: '',
  voice_reference: '',
  avatar_uuid: null,
};

function toForm(persona: Persona): PersonaFormData {
  return {
    name: persona.name,
    description: persona.description || '',
    system_prompt: persona.system_prompt || '',
    preferred_name: persona.preferred_name || '',
    voice_reference: persona.voice_reference || '',
    avatar_uuid: persona.avatar_uuid,
  };
}

interface PersonaEditDialogProps {
  open: boolean;
  /** null creates a new persona. */
  persona: Persona | null;
  /** Voice reference names from `GET /tts/voices`. */
  voices: string[];
  onClose: () => void;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}

/**
 * Create/edit one persona: presentation only. No model, no tools, no memory and
 * no wake word — those belong to the assistant and are edited in its own
 * section. `character_config` is not part of this form: the graph editor writes
 * it straight through `PATCH /character-assets/{persona_id}/character-config`,
 * so sending it back from here would clobber whatever was just drawn.
 */
export const PersonaEditDialog: React.FC<PersonaEditDialogProps> = ({
  open,
  persona,
  voices,
  onClose,
  onSaved,
  onError,
}) => {
  const isCreate = persona === null;
  const [form, setForm] = useState<PersonaFormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [characterOpen, setCharacterOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      // Never leave the full-screen graph editor behind a closed parent.
      setCharacterOpen(false);
      return;
    }
    setForm(persona ? toForm(persona) : EMPTY_FORM);
  }, [open, persona]);

  const handleAvatarFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      setUploadingAvatar(true);
      const { image_uuid } = await apiClient.uploadImage(file);
      setForm((prev) => ({ ...prev, avatar_uuid: image_uuid }));
    } catch (err: any) {
      onError(err?.response?.data?.detail || err?.message || 'Failed to upload the avatar.');
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleSave = async () => {
    const name = form.name.trim();
    if (!name) return;
    try {
      setSaving(true);
      if (isCreate) {
        const body: PersonaCreate = {
          name,
          description: form.description || undefined,
          system_prompt: form.system_prompt || undefined,
          preferred_name: form.preferred_name || undefined,
          voice_reference: form.voice_reference || undefined,
          avatar_uuid: form.avatar_uuid || undefined,
        };
        const created = await apiClient.createPersona(body);
        onSaved(`Persona "${created.name}" created.`);
      } else {
        const saved = toForm(persona!);
        const body: PersonaUpdate = {};
        if (name !== saved.name) body.name = name;
        if (form.description !== saved.description) body.description = form.description;
        if (form.system_prompt !== saved.system_prompt) body.system_prompt = form.system_prompt;
        // An explicit null is how a field is cleared; omitting it leaves it alone.
        if (form.preferred_name !== saved.preferred_name) body.preferred_name = form.preferred_name || null;
        if (form.voice_reference !== saved.voice_reference) body.voice_reference = form.voice_reference || null;
        if (form.avatar_uuid !== saved.avatar_uuid) body.avatar_uuid = form.avatar_uuid;

        if (Object.keys(body).length > 0) {
          await apiClient.updatePersona(persona!.id, body);
        }
        onSaved(`Persona "${name}" saved.`);
      }
      onClose();
    } catch (err: any) {
      onError(err?.response?.data?.detail || err?.message || 'Failed to save the persona.');
    } finally {
      setSaving(false);
    }
  };

  // A voice the backend no longer lists (renamed folder, TTS off) must still be
  // visible rather than silently reset to none.
  const voiceOptions = form.voice_reference && !voices.includes(form.voice_reference)
    ? [form.voice_reference, ...voices]
    : voices;

  return (
    <>
      <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
        <DialogTitle>{isCreate ? 'New persona' : `Edit ${persona!.name}`}</DialogTitle>

        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, mt: 1 }}>
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 0.5 }}>
              <Box
                onClick={() => { if (!uploadingAvatar) fileInputRef.current?.click(); }}
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
                  src={form.avatar_uuid ? apiClient.getImageUrl(form.avatar_uuid) : undefined}
                  sx={{
                    width: 96,
                    height: 96,
                    bgcolor: (t) => (t.palette.mode === 'light' ? '#F3F4F6' : '#262626'),
                  }}
                >
                  {!form.avatar_uuid && <PersonaIcon sx={{ fontSize: 40, color: 'text.secondary' }} />}
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
                <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={handleAvatarFileChange} />
              </Box>
            </Box>

            <TextField
              label="Name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              fullWidth
              required
              helperText="The name shown on every reply this persona speaks."
            />

            <TextField
              label="Description"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              fullWidth
              helperText="A one-line note for you. It is not sent to the model."
            />

            <TextField
              label="System prompt"
              value={form.system_prompt}
              onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
              multiline
              minRows={6}
              maxRows={16}
              fullWidth
              helperText="Who this persona is and how it speaks."
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

            <TextField
              label="Calls you"
              value={form.preferred_name}
              onChange={(e) => setForm({ ...form, preferred_name: e.target.value })}
              fullWidth
              helperText="What this persona calls you. Leave empty to use the name in your account settings."
            />

            <TextField
              select
              label="Voice"
              value={form.voice_reference}
              onChange={(e) => setForm({ ...form, voice_reference: e.target.value })}
              fullWidth
              helperText={
                voices.length === 0
                  ? 'No reference voices found on the server.'
                  : 'Reference voice used when this persona is spoken aloud.'
              }
            >
              <MenuItem value="">Default voice</MenuItem>
              {voiceOptions.map((v) => (
                <MenuItem key={v} value={v}>{v}</MenuItem>
              ))}
            </TextField>

            <Box>
              <Button
                variant="outlined"
                startIcon={<CharacterIcon />}
                onClick={() => setCharacterOpen(true)}
                disabled={isCreate}
                fullWidth
              >
                Edit character graph
              </Button>
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                {isCreate
                  ? 'Available once the persona exists — its poses and videos are stored under its id.'
                  : 'Poses, blink/breathing timing and transition videos for the animated character window. Saved as you edit.'}
              </Typography>
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

      {persona && (
        <CharacterConfigDialog
          open={characterOpen}
          persona={persona}
          onClose={() => setCharacterOpen(false)}
          onSaved={() => { /* the graph editor auto-saves; nothing to reconcile here */ }}
        />
      )}
    </>
  );
};
