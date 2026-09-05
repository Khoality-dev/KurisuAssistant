import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Grid,
  IconButton,
  Paper,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  AccountCircle as PersonaIcon,
  Add as AddIcon,
  FileUpload as ImportIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import { AnimatePresence } from 'framer-motion';
import { apiClient } from '../../api/client';
import { usePersonaStore } from '../../store/personaStore';
import { storage } from '../../utils/storage';
import type { Persona } from '../../api/types';
import { ResourceCard } from './ResourceCard';
import { PersonaEditDialog } from './PersonaEditDialog';

/**
 * Personas: how the assistant sounds. A name, a prompt, a voice, a face — and
 * nothing else. Capability (model, tools, memory, wake word) lives on the single
 * assistant, one section over.
 */
export const PersonasSection: React.FC = () => {
  const reloadPersonaStore = usePersonaStore((s) => s.loadPersonas);

  const [personas, setPersonas] = useState<Persona[]>([]);
  const [voices, setVoices] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Persona | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Persona | null>(null);

  const importInputRef = useRef<HTMLInputElement>(null);

  const flash = (message: string) => {
    setSuccessMessage(message);
    setTimeout(() => setSuccessMessage(''), 3000);
  };

  const loadPersonas = async () => {
    try {
      setLoading(true);
      setPersonas(await apiClient.listPersonas());
      // Keep the sidebar/chat selector in step with what was just edited.
      void reloadPersonaStore();
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to load personas');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPersonas();
    apiClient.listVoices().then(setVoices).catch(() => setVoices([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggleEnabled = async (persona: Persona, enabled: boolean) => {
    try {
      await apiClient.togglePersonaEnabled(persona.id, enabled);
      await loadPersonas();
    } catch (err: any) {
      // The backend refuses to disable the default persona: a new conversation
      // would have nobody to bind to.
      setError(err.response?.data?.detail || err.message || 'Failed to change the persona');
    }
  };

  const handleExport = async (persona: Persona) => {
    try {
      const blob = await apiClient.exportPersona(persona.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${persona.name.replace(/\s+/g, '_')}.json`;
      a.click();
      URL.revokeObjectURL(url);
      flash(`Persona "${persona.name}" exported. Avatar, voice and character art stay behind.`);
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to export the persona');
    }
  };

  const handleImport = async (file: File) => {
    try {
      const persona = await apiClient.importPersona(file);
      flash(`Persona "${persona.name}" imported.`);
      await loadPersonas();
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to import the persona');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await apiClient.deletePersona(deleteTarget.id);
      storage.clearPersonaConversationId(deleteTarget.id);
      flash(`Persona "${deleteTarget.name}" deleted.`);
      setDeleteTarget(null);
      await loadPersonas();
    } catch (err: any) {
      // The last persona cannot be deleted — a user with none could not start a
      // conversation at all.
      setError(err.response?.data?.detail || err.message || 'Failed to delete the persona');
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
          <Button variant="outlined" startIcon={<ImportIcon />} onClick={() => importInputRef.current?.click()}>
            Import
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
            Create one to give your assistant a name and a voice. Your first persona becomes the
            one new conversations start with.
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
          <Grid container spacing={3}>
            <AnimatePresence>
              {personas.map((persona) => (
                <Grid item xs={12} sm={6} md={4} key={persona.id}>
                  <ResourceCard
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
                      persona.voice_reference ? `voice: ${persona.voice_reference}` : null,
                      persona.character_config ? 'character graph' : null,
                    ]}
                    enabled={persona.enabled}
                    onToggleEnabled={(enabled) => void handleToggleEnabled(persona, enabled)}
                    onExport={() => void handleExport(persona)}
                    onDelete={() => setDeleteTarget(persona)}
                    onClick={() => openEdit(persona)}
                  />
                </Grid>
              ))}
            </AnimatePresence>
          </Grid>
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

      <Dialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)}>
        <DialogTitle>Delete persona</DialogTitle>
        <DialogContent>
          <Typography>
            Delete "{deleteTarget?.name}"? This cannot be undone. Conversations it answered stay,
            unbound — the next message in one falls back to your default persona.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button variant="contained" color="error" onClick={handleDelete}>Delete</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};
