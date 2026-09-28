import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Avatar,
  Box,
  Button,
  ButtonBase,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Paper,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  AccountCircle as PersonaIcon,
  Add as AddIcon,
  ChatBubbleOutline as TalkIcon,
  SmartToy as AssistantIcon,
  FileUpload as ImportIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import { AnimatePresence } from 'framer-motion';
import { apiClient, describeRequestFailure } from '@kurisu/api';
import { usePersonaStore } from '@kurisu/state';
import { storage } from '@kurisu/api';
import { parseCharacterConfig, type Persona, type PersonaExportSize, type VoiceInfo } from '@kurisu/models';
import {
  AccountTree as GraphIcon,
  Animation as AnimationIcon,
  InfoOutlined as InfoIcon,
  ViewInAr as ModelIcon,
} from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import { ResourceCard } from './ResourceCard';
import { InTheChatChip, selectionColors } from '../InTheChatChip';
import { PersonaEditDialog, voiceName } from './PersonaEditDialog';
import { mb, modelFilename } from '../character/vrmSetupText';
import { exportedFilename, importFailure, includeLine, isBundle, meteredLine } from './personaExport';

/** The card's line for the character: which system the persona shows, and what it has. */
export function characterLabel(config: Persona['character_config']): string {
  const parsed = parseCharacterConfig(config);
  if (!parsed) return 'No character';
  if (parsed.kind === 'vrm') {
    const model = parsed.vrm?.model;
    return model ? `3D model · ${modelFilename(model)}` : '3D model · none uploaded';
  }
  const poses = parsed.poseTree?.nodes?.length ?? 0;
  return poses ? `2D pose graph · ${poses} pose${poses === 1 ? '' : 's'}` : 'No character';
}

export interface DeletedFileLine {
  kind: 'model' | 'clips' | 'graph' | 'none';
  text: string;
  size: string;
}

/**
 * What deleting a persona takes with it, listed before it goes. Both members
 * count whichever one shows: switching kinds removes nothing, so a persona can
 * hold a model and a pose graph at once. `vrmBytes` is the server's own sum
 * (`GET /character-assets/usage`) when it answered.
 */
export function deletedFiles(config: Persona['character_config'], vrmBytes?: number): DeletedFileLine[] {
  const parsed = parseCharacterConfig(config);
  const lines: DeletedFileLine[] = [];
  const model = parsed?.vrm?.model;
  const clips = parsed?.vrm?.clips ?? [];
  if (model) {
    const size = clips.length ? model.bytes : vrmBytes ?? model.bytes;
    lines.push({ kind: 'model', text: `3D model · ${modelFilename(model)}`, size: mb(size) });
  }
  if (clips.length) {
    const clipBytes = clips.reduce((sum, c) => sum + (c.bytes || 0), 0);
    lines.push({ kind: 'clips', text: `${clips.length} of your own animation${clips.length === 1 ? '' : 's'}`, size: mb(clipBytes) });
  }
  const tree = parsed?.poseTree;
  if (tree?.nodes?.length) {
    let images = 0;
    for (const n of tree.nodes) {
      const pc = n.pose_config;
      if (!pc) continue;
      if (pc.base_image_url) images++;
      images += (pc.left_eye?.patches?.length ?? 0) + (pc.right_eye?.patches?.length ?? 0) + (pc.mouth?.patches?.length ?? 0);
    }
    const videos = (tree.edges ?? []).reduce((sum, e) => sum + (e.transitions ?? []).reduce((t, x) => t + (x.video_urls?.length ?? 0), 0), 0);
    lines.push({ kind: 'graph', text: `Pose graph · ${images} image${images === 1 ? '' : 's'}, ${videos} video${videos === 1 ? '' : 's'}`, size: '' });
  }
  if (!lines.length) lines.push({ kind: 'none', text: 'No character files', size: '' });
  return lines;
}

/**
 * Personas: how the assistant sounds. A name, a prompt, a voice, a face — and
 * nothing else. Capability (model, tools, memory, wake word) lives on the single
 * assistant, one section over.
 *
 * The one thing about the assistant that IS decided here is who the chat is on
 * (#334): the assistant's `selected_persona_id`, the same selection the chat
 * header and the Conversations page make, kept on the server so every device
 * opens on it. "Talk to" puts the chat on a persona and the card wears the
 * badge; a persona is optional (#302), and "Use the assistant" takes it off
 * again, which is where every account starts.
 */
export const PersonasSection: React.FC = () => {
  const reloadPersonaStore = usePersonaStore((s) => s.loadPersonas);
  const selectedPersonaId = usePersonaStore((s) => s.selectedPersonaId);
  const selectPersona = usePersonaStore((s) => s.selectPersona);

  const sel = selectionColors(useTheme());
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Persona | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Persona | null>(null);
  /** The server's per-persona 3D bytes, for the delete confirm; absent if it did not answer. */
  const [vrmBytes, setVrmBytes] = useState<Record<number, number>>({});

  useEffect(() => {
    if (!deleteTarget) return;
    apiClient.getCharacterUsage()
      .then((usage) => setVrmBytes(Object.fromEntries(usage.per_persona.map((p) => [p.persona_id, p.bytes]))))
      .catch(() => setVrmBytes({}));
  }, [deleteTarget]);

  /** The persona whose export dialog is open, and what its character weighs (#248). */
  const [exportTarget, setExportTarget] = useState<Persona | null>(null);
  const [exportSize, setExportSize] = useState<PersonaExportSize | 'loading' | 'failed'>('loading');
  const [includeCharacter, setIncludeCharacter] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!exportTarget) return;
    let cancelled = false;
    setExportSize('loading');
    setIncludeCharacter(true);
    apiClient.exportPersonaSize(exportTarget.id)
      .then((size) => { if (!cancelled) setExportSize(size); })
      .catch(() => { if (!cancelled) setExportSize('failed'); });
    return () => { cancelled = true; };
  }, [exportTarget]);

  const importInputRef = useRef<HTMLInputElement>(null);

  const flash = (message: string) => {
    setSuccessMessage(message);
    setTimeout(() => setSuccessMessage(''), 3000);
  };

  const loadPersonas = async () => {
    try {
      setLoading(true);
      setPersonas(await apiClient.listPersonas());
      // Keep the chat, and who it is on, in step with what was just edited.
      void reloadPersonaStore();
    } catch (err: any) {
      setError(describeRequestFailure(err, 'Failed to load personas'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPersonas();
    apiClient.listVoices().then(setVoices).catch(() => setVoices([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTalkTo = (persona: Persona) => {
    if (persona.id === selectedPersonaId) return;
    selectPersona(persona.id);
    flash(`The chat is on ${persona.name}.`);
  };

  const handleUseAssistant = () => {
    selectPersona(null);
    flash('The chat is on the assistant itself.');
  };

  const handleToggleEnabled = async (persona: Persona, enabled: boolean) => {
    try {
      // Disabling the one the chat is on is allowed: the server clears the
      // selection and the reload puts the chat back on the assistant (#302, #334).
      await apiClient.togglePersonaEnabled(persona.id, enabled);
      await loadPersonas();
    } catch (err: any) {
      setError(describeRequestFailure(err, 'Failed to change the persona'));
    }
  };

  /** The export dialog's choice, carried out: a zip with the character, or the JSON file without. */
  const handleExport = async () => {
    const persona = exportTarget;
    if (!persona) return;
    const size = typeof exportSize === 'object' ? exportSize.character : null;
    const withCharacter = includeCharacter && size !== null;
    setExporting(true);
    try {
      const blob = await apiClient.exportPersona(persona.id, { character: withCharacter });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = exportedFilename(persona.name, withCharacter);
      a.click();
      URL.revokeObjectURL(url);
      flash(withCharacter
        ? `Persona "${persona.name}" exported with its character. Avatar and voice stay behind.`
        : `Persona "${persona.name}" exported. Avatar, voice and character stay behind.`);
      setExportTarget(null);
    } catch (err: any) {
      setError(describeRequestFailure(err, 'Failed to export the persona'));
      setExportTarget(null);
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async (file: File) => {
    const bundle = isBundle(file);
    setImporting(true);
    try {
      const persona = bundle ? await apiClient.importPersonaBundle(file) : await apiClient.importPersona(file);
      flash(bundle ? `Persona "${persona.name}" imported with its character.` : `Persona "${persona.name}" imported.`);
      await loadPersonas();
    } catch (err: any) {
      setError(bundle ? importFailure(err) : describeRequestFailure(err, 'Failed to import the persona'));
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await apiClient.deletePersona(deleteTarget.id);
      storage.clearPersonaConversationId(deleteTarget.id);
      flash(`${deleteTarget.name} and all of its character files were deleted.`);
      setDeleteTarget(null);
      await loadPersonas();
    } catch (err: any) {
      // Any persona can be deleted, the last one included (#302); what is left
      // here is a network or server failure.
      setError(describeRequestFailure(err, 'Failed to delete the persona'));
      setDeleteTarget(null);
    }
  };

  const openCreate = () => {
    setEditing(null);
    setEditDialogOpen(true);
  };

  const openEdit = (persona: Persona) => {
    setEditing(persona);
    setEditDialogOpen(true);
  };

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 0.5, fontWeight: 600 }}>Personas</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        How your assistant sounds: a name, a prompt, a voice, a face. A persona owns no model,
        no tools and no memory — switching personas changes who answers, never what it can do.
      </Typography>

      <Paper
        elevation={0}
        sx={{
          p: 2,
          mb: 3,
          borderBottom: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Typography variant="h6">{personas.length} persona{personas.length === 1 ? '' : 's'}</Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Tooltip title="Reload personas">
            <IconButton onClick={loadPersonas} disabled={loading}>
              <RefreshIcon sx={{ animation: loading ? 'spin 1s linear infinite' : 'none', '@keyframes spin': { '0%': { transform: 'rotate(0deg)' }, '100%': { transform: 'rotate(360deg)' } } }} />
            </IconButton>
          </Tooltip>
          <Button variant="outlined" startIcon={<ImportIcon />} onClick={() => importInputRef.current?.click()} disabled={importing}>
            {importing ? 'Importing…' : 'Import'}
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept=".zip,.json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImport(file);
              e.target.value = '';
            }}
          />
          <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
            New Persona
          </Button>
        </Box>
      </Paper>

      {successMessage && <Alert severity="success" sx={{ mb: 3, maxWidth: 1200, mx: 'auto' }}>{successMessage}</Alert>}
      {error && (
        <Alert severity="error" sx={{ mb: 3, maxWidth: 1200, mx: 'auto' }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Typography sx={{ textAlign: 'center', mt: 4 }}>Loading personas…</Typography>
      ) : personas.length === 0 ? (
        <Paper sx={{ p: 4, textAlign: 'center', maxWidth: 600, mx: 'auto' }}>
          <Typography variant="h6" gutterBottom>No personas yet</Typography>
          <Typography color="text.secondary" sx={{ mb: 3 }}>
            Without one, the assistant answers as itself. Create a persona to give it a name, a
            voice and a face, then talk to it here or from the chat header.
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, justifyContent: 'center' }}>
            <Button variant="outlined" startIcon={<ImportIcon />} onClick={() => importInputRef.current?.click()}>
              Import
            </Button>
            <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
              New Persona
            </Button>
          </Box>
        </Paper>
      ) : (
        <Box sx={{ maxWidth: 1200, mx: 'auto' }}>
          {/* The assistant itself, above the personas (#348): who the chat is on
              when no persona is chosen, so the choice is marked here too. */}
          <ButtonBase
            role="group"
            aria-label="Assistant"
            aria-current={selectedPersonaId === null ? 'true' : undefined}
            // Already on the assistant: a plain row, not a control.
            component={selectedPersonaId === null ? 'div' : 'button'}
            tabIndex={selectedPersonaId === null ? -1 : 0}
            disableRipple={selectedPersonaId === null}
            onClick={selectedPersonaId === null ? undefined : handleUseAssistant}
            sx={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-start',
              gap: '14px',
              px: 2,
              py: 1.5,
              mb: 2,
              borderRadius: 1,
              textAlign: 'left',
              fontFamily: 'inherit',
              color: 'text.primary',
              ...(selectedPersonaId === null
                ? { bgcolor: 'background.paper', boxShadow: `inset 0 0 0 2px ${sel.line}` }
                : { border: '1px dashed', borderColor: (t) => (t.palette.mode === 'light' ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.13)'), '&:hover': { bgcolor: 'action.hover' } }),
              cursor: selectedPersonaId === null ? 'default' : 'pointer',
            }}
          >
            <Avatar sx={{ width: 40, height: 40, bgcolor: (t) => (t.palette.mode === 'light' ? '#F3F4F6' : '#262626'), flexShrink: 0 }}>
              <AssistantIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
            </Avatar>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ fontSize: 15, fontWeight: 600, color: selectedPersonaId === null ? 'text.primary' : 'text.secondary' }}>
                Assistant
              </Typography>
              <Typography variant="body2" color="text.secondary">No persona. The assistant answers as itself.</Typography>
            </Box>
            {selectedPersonaId === null && <InTheChatChip />}
          </ButtonBase>

          {/* Columns sized to the pane, not the window, so the card actions do not wrap (#348). */}
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 2 }}>
            <AnimatePresence>
              {personas.map((persona) => (
                  <ResourceCard
                    key={persona.id}
                    avatar={
                      <Avatar
                        src={persona.avatar_uuid ? apiClient.getImageUrl(persona.avatar_uuid) : undefined}
                        sx={{
                          width: 44,
                          height: 44,
                          bgcolor: (t) => (t.palette.mode === 'light' ? '#F3F4F6' : '#262626'),
                          flexShrink: 0,
                        }}
                      >
                        {!persona.avatar_uuid && <PersonaIcon sx={{ fontSize: 22, color: 'text.secondary' }} />}
                      </Avatar>
                    }
                    title={persona.name}
                    description={persona.description || undefined}
                    body={persona.system_prompt || 'No system prompt set'}
                    meta={[
                      persona.voice_reference ? `voice: ${voiceName(voices, persona.voice_reference)}` : null,
                      characterLabel(persona.character_config),
                    ]}
                    selected={persona.id === selectedPersonaId}
                    badge={persona.id === selectedPersonaId ? <InTheChatChip /> : undefined}
                    action={persona.id === selectedPersonaId
                      ? (
                        <Button
                          size="small"
                          color="inherit"
                          startIcon={<AssistantIcon sx={{ color: 'text.secondary' }} />}
                          sx={{ whiteSpace: 'nowrap' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleUseAssistant();
                          }}
                        >
                          Use the assistant
                        </Button>
                      )
                      : persona.enabled
                        ? (
                          <Button
                            size="small"
                            variant="outlined"
                            color="inherit"
                            startIcon={<TalkIcon />}
                            sx={{ whiteSpace: 'nowrap', borderColor: 'divider' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleTalkTo(persona);
                            }}
                          >
                            Talk to
                          </Button>
                        )
                        : undefined}
                    enabled={persona.enabled}
                    onToggleEnabled={(enabled) => void handleToggleEnabled(persona, enabled)}
                    onExport={() => setExportTarget(persona)}
                    onDelete={() => setDeleteTarget(persona)}
                    onClick={() => openEdit(persona)}
                  />
              ))}
            </AnimatePresence>
          </Box>
        </Box>
      )}

      <PersonaEditDialog
        open={editDialogOpen}
        persona={editing}
        voices={voices}
        onClose={() => {
          setEditDialogOpen(false);
          // Reload on close rather than on save: the graph editor auto-saves
          // `character_config` behind this dialog, and reloading the list while
          // the form is open would replace the persona under the user's edits.
          void loadPersonas();
        }}
        onSaved={flash}
        onError={setError}
      />

      <Dialog open={exportTarget !== null} onClose={() => !exporting && setExportTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Export {exportTarget?.name}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            Its name, description and prompt always go. Its avatar and voice stay on this server.
          </Typography>
          {exportSize === 'loading' && (
            <Typography variant="body2" color="text.secondary">Measuring the character…</Typography>
          )}
          {exportSize === 'failed' && (
            <Alert severity="warning">
              The server did not say how big the character is, so it cannot be included. The export will be the persona alone.
            </Alert>
          )}
          {typeof exportSize === 'object' && (
            exportSize.character ? (
              <>
                <FormControlLabel
                  control={<Checkbox checked={includeCharacter} onChange={(e) => setIncludeCharacter(e.target.checked)} />}
                  label={includeLine(exportSize.character)}
                />
                {includeCharacter && meteredLine(exportSize.character) && (
                  <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
                    {meteredLine(exportSize.character)}
                  </Typography>
                )}
              </>
            ) : (
              <Typography variant="body2" color="text.secondary">{includeLine(null)}</Typography>
            )
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setExportTarget(null)} disabled={exporting}>Cancel</Button>
          <Button variant="contained" onClick={() => void handleExport()} disabled={exporting || exportSize === 'loading'}>
            {exporting ? 'Exporting…' : 'Export'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete {deleteTarget?.name}?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            Past conversations keep their messages, and the assistant answers in them from now on.
            {deleteTarget?.id === selectedPersonaId ? ' The chat goes back to the assistant too.' : ''}
            {' '}Everything below is deleted from the server. This cannot be undone.
          </Typography>
          <Paper variant="outlined" sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {deleteTarget && deletedFiles(deleteTarget.character_config, vrmBytes[deleteTarget.id]).map((line) => (
              <Box key={line.text} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                {line.kind === 'model' && <ModelIcon fontSize="small" color="error" />}
                {line.kind === 'clips' && <AnimationIcon fontSize="small" color="error" />}
                {line.kind === 'graph' && <GraphIcon fontSize="small" color="error" />}
                {line.kind === 'none' && <InfoIcon fontSize="small" color="disabled" />}
                <Typography variant="body2" sx={{ flex: 1 }}>{line.text}</Typography>
                <Typography variant="caption" color="text.secondary">{line.size}</Typography>
              </Box>
            ))}
          </Paper>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button variant="contained" color="error" onClick={handleDelete}>Delete persona</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};
