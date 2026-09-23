import React, { useEffect, useRef, useState } from 'react';
import {
  Avatar,
  Box,
  Button,
  ButtonBase,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Radio,
  Snackbar,
  TextField,
  Typography,
} from '@mui/material';
import {
  AccountCircle as PersonaIcon,
  AccountTree as GraphIcon,
  PhotoCamera as PhotoCameraIcon,
  Save as SaveIcon,
  ViewInAr as ModelIcon,
} from '@mui/icons-material';
import { apiClient, describeRequestFailure } from '@kurisu/api';
import {
  parseCharacterConfig,
  type CharacterConfigDTO,
  type CharacterKind,
  type Persona,
  type PersonaCreate,
  type PersonaUpdate,
} from '@kurisu/models';
import { CharacterConfigDialog } from '../character/CharacterConfigDialog';
import { VrmSetupDialog } from '../character/VrmSetupDialog';
import { mb, modelFilename } from '../character/vrmSetupText';

/** What each kind card says about the persona's own setup of that kind. */
function kindStatus(kind: CharacterKind, config: CharacterConfigDTO | null): string {
  const parsed = parseCharacterConfig(config);
  if (kind === 'pose_graph') {
    const tree = parsed?.poseTree;
    if (!tree || !tree.nodes?.length) return 'Not set up';
    return `${tree.nodes.length} pose${tree.nodes.length === 1 ? '' : 's'} · ${tree.edges?.length ?? 0} transition${tree.edges?.length === 1 ? '' : 's'}`;
  }
  const model = parsed?.vrm?.model;
  return model ? `${modelFilename(model)} · ${mb(model.bytes)}` : 'No model uploaded';
}

const KIND_CARDS: ReadonlyArray<{ kind: CharacterKind; title: string; sub: string; icon: React.ReactNode }> = [
  { kind: 'pose_graph', title: '2D pose graph', sub: 'Portrait poses with eye and mouth patches, and videos between poses.', icon: <GraphIcon /> },
  { kind: 'vrm', title: '3D model (VRM)', sub: 'A VRoid Studio avatar that talks, blinks, moves and shows feelings.', icon: <ModelIcon /> },
];

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
 * section. `character_config` is not part of this form: the character block
 * picks the system (a `PATCH {kind}` that saves at once and removes nothing),
 * and the two editors write their own member through
 * `PATCH /character-assets/{persona_id}/character-config`, so sending it back
 * from here would clobber whatever was just drawn or uploaded.
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
  const [vrmOpen, setVrmOpen] = useState(false);
  /** The character config as the server last returned it; the persona prop is only the list's copy. */
  const [characterConfig, setCharacterConfig] = useState<CharacterConfigDTO | null>(null);
  const [kindBusy, setKindBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      // Never leave a full-screen character editor behind a closed parent.
      setCharacterOpen(false);
      setVrmOpen(false);
      return;
    }
    setForm(persona ? toForm(persona) : EMPTY_FORM);
    setCharacterConfig(persona?.character_config ?? null);
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
      onError(describeRequestFailure(err, 'Failed to upload the avatar.'));
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
      onError(describeRequestFailure(err, 'Failed to save the persona.'));
    } finally {
      setSaving(false);
    }
  };

  const character = parseCharacterConfig(characterConfig);
  const selectedKind = character?.kind ?? null;

  /** Switching saves at once and removes nothing: the other system's settings and files stay. */
  const pickKind = async (kind: CharacterKind) => {
    if (!persona || kind === selectedKind || kindBusy) return;
    try {
      setKindBusy(true);
      const res = await apiClient.updateCharacterConfig(persona.id, { kind });
      setCharacterConfig(res?.character_config ?? { ...(characterConfig ?? {}), kind });
      window.dispatchEvent(new CustomEvent('character-config-saved', { detail: { personaId: persona.id } }));
      const other = kind === 'vrm'
        ? (character?.poseTree?.nodes?.length ? ' The pose graph is kept.' : '')
        : (character?.vrm?.model ? ' The 3D model is kept.' : '');
      setToast(`${form.name || persona.name} now uses the ${kind === 'vrm' ? '3D model' : '2D pose graph'}.${other}`);
    } catch (err: any) {
      onError(describeRequestFailure(err, 'Failed to change the character system.'));
    } finally {
      setKindBusy(false);
    }
  };

  const displayName = form.name || persona?.name || 'this persona';
  let kindNote = `Pick a system above to give ${displayName} a character.`;
  if (selectedKind === 'vrm') {
    kindNote = character?.vrm?.model
      ? 'Switching saves right away. The pose graph’s files stay on the server until you remove them in its editor.'
      : 'Nothing shows in the character window until a model is uploaded.';
  }
  if (selectedKind === 'pose_graph') {
    kindNote = 'Switching saves right away. A 3D model, if one was uploaded, stays until you remove it in the 3D setup.';
  }

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
              <Typography variant="subtitle2">Character</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                {isCreate
                  ? 'Available once the persona exists — its character files are stored under its id.'
                  : `What stands in the character window when ${displayName} speaks.`}
              </Typography>
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
                {KIND_CARDS.map((card) => {
                  const selected = selectedKind === card.kind;
                  const status = kindStatus(card.kind, characterConfig);
                  const unset = status.startsWith('No') || status.startsWith('Not');
                  return (
                    <ButtonBase
                      key={card.kind}
                      disabled={isCreate || kindBusy}
                      onClick={() => void pickKind(card.kind)}
                      aria-pressed={selected}
                      sx={{
                        display: 'block', textAlign: 'left', p: 1.5, borderRadius: 1.5, border: 1,
                        borderColor: selected ? 'primary.main' : 'divider', bgcolor: selected ? 'action.selected' : 'transparent',
                        opacity: isCreate ? 0.5 : 1,
                      }}
                    >
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: selected ? 'primary.main' : 'text.secondary' }}>
                        {card.icon}
                        <Typography variant="body2" sx={{ fontWeight: 600, flex: 1, color: 'text.primary' }}>{card.title}</Typography>
                        <Radio size="small" checked={selected} tabIndex={-1} sx={{ p: 0 }} />
                      </Box>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>{card.sub}</Typography>
                      <Typography variant="caption" sx={{ display: 'block', mt: 0.75, color: unset ? 'warning.main' : 'text.secondary' }}>
                        {status}
                      </Typography>
                    </ButtonBase>
                  );
                })}
              </Box>
              {!isCreate && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 1.5 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>{kindNote}</Typography>
                  <Button
                    variant="contained"
                    size="small"
                    disabled={!selectedKind}
                    startIcon={selectedKind === 'vrm' ? <ModelIcon /> : <GraphIcon />}
                    onClick={() => (selectedKind === 'vrm' ? setVrmOpen(true) : setCharacterOpen(true))}
                  >
                    {selectedKind === 'vrm' ? 'Set up 3D character' : 'Edit character graph'}
                  </Button>
                </Box>
              )}
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
          persona={{ ...persona, character_config: characterConfig }}
          onClose={() => {
            setCharacterOpen(false);
            // The graph editor saves behind this dialog; read back what it wrote.
            apiClient.getPersona(persona.id).then((p) => setCharacterConfig(p.character_config)).catch(() => {});
          }}
          onSaved={() => { /* the graph editor auto-saves; nothing to reconcile here */ }}
        />
      )}
      {persona && (
        <VrmSetupDialog
          open={vrmOpen}
          persona={{ ...persona, name: displayName }}
          characterConfig={characterConfig}
          onClose={() => setVrmOpen(false)}
          onCharacterChange={setCharacterConfig}
        />
      )}
      <Snackbar open={!!toast} autoHideDuration={2800} onClose={() => setToast(null)} message={toast ?? ''} />
    </>
  );
};
