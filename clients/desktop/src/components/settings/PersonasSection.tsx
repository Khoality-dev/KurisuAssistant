import React, { useState, useEffect, useRef } from 'react';
import {
  Box,
  Paper,
  Typography,
  Button,
  Avatar,
  IconButton,
  Alert,
  Card,
  CardContent,
  CardActions,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Chip,
  Grid,
  Tooltip,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  MicNone as MicIcon,
  Refresh as RefreshIcon,
  Face as FaceIcon,
  FileDownload as ExportIcon,
  FileUpload as ImportIcon,
} from '@mui/icons-material';
import { motion, AnimatePresence } from 'framer-motion';
import { apiClient } from '../../api/client';
import { usePersonaStore } from '../../store/personaStore';
import type { Persona, PersonaCreate, PersonaUpdate, Agent, AvatarCandidate } from '../../api/types';
import { CharacterConfigDialog } from '../CharacterConfigDialog';
import { PersonaCreateDialog } from './PersonaCreateDialog';
import { PersonaEditDialog } from './PersonaEditDialog';

const MotionCard = motion(Card);

interface PersonaFormData {
  name: string;
  system_prompt: string;
  preferred_name: string;
  trigger_word: string;
}

export const PersonasSection: React.FC = () => {
  const { loadPersonas: refreshPersonaStore } = usePersonaStore();
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  // Dialog states
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [characterConfigOpen, setCharacterConfigOpen] = useState(false);
  const [characterConfigAgent, setCharacterConfigAgent] = useState<Agent | null>(null);
  const [selectedPersona, setSelectedPersona] = useState<Persona | null>(null);

  // We need agents to find the linked agent for a persona (for CharacterConfigDialog)
  const [agents, setAgents] = useState<Agent[]>([]);

  // Form data
  const [formData, setFormData] = useState<PersonaFormData>({
    name: '',
    system_prompt: '',
    preferred_name: '',
    trigger_word: '',
  });

  // File upload refs
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const voiceInputRef = useRef<HTMLInputElement>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarCandidates, setAvatarCandidates] = useState<AvatarCandidate[]>([]);
  const [isDetecting, setIsDetecting] = useState(false);
  const [isPromptEditorExpanded, setIsPromptEditorExpanded] = useState(false);

  const importInputRef = useRef<HTMLInputElement>(null);
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null);
  const [playingVoicePersonaId, setPlayingVoicePersonaId] = useState<number | null>(null);

  useEffect(() => {
    loadPersonas();
    loadAgents();
  }, []);

  const loadAgents = async () => {
    try {
      const data = await apiClient.listAgents();
      setAgents(data);
    } catch {
      // Non-critical — just means CharacterConfig won't be available
    }
  };

  const findLinkedAgent = (personaId: number): Agent | null => {
    return agents.find((a) => a.persona_id === personaId) || null;
  };

  const loadPersonas = async () => {
    try {
      setLoading(true);
      const data = await apiClient.listPersonas();
      setPersonas(data);
      refreshPersonaStore();
    } catch (err: any) {
      setError(err.message || 'Failed to load personas');
    } finally {
      setLoading(false);
    }
  };

  const handleCreatePersona = async () => {
    try {
      const createData: PersonaCreate = {
        name: formData.name,
        system_prompt: formData.system_prompt || undefined,
        preferred_name: formData.preferred_name || undefined,
        trigger_word: formData.trigger_word || undefined,
      };

      const newPersona = await apiClient.createPersona(createData);

      if (avatarFile) {
        await apiClient.updatePersonaAvatar(newPersona.id, avatarFile);
      }
      if (voiceFile) {
        await apiClient.updatePersonaVoice(newPersona.id, voiceFile);
      }

      setSuccessMessage(`Persona "${newPersona.name}" created successfully!`);
      setTimeout(() => setSuccessMessage(''), 3000);
      setCreateDialogOpen(false);
      resetForm();
      loadPersonas();
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to create persona');
    }
  };

  const handleUpdatePersona = async () => {
    if (!selectedPersona) return;

    try {
      const updateData: PersonaUpdate = {
        name: formData.name !== selectedPersona.name ? formData.name : undefined,
        system_prompt: formData.system_prompt !== selectedPersona.system_prompt ? formData.system_prompt : undefined,
        preferred_name: formData.preferred_name !== (selectedPersona.preferred_name || '') ? formData.preferred_name : undefined,
        trigger_word: formData.trigger_word !== (selectedPersona.trigger_word || '') ? formData.trigger_word : undefined,
      };

      const hasChanges = Object.values(updateData).some((v) => v !== undefined);
      if (hasChanges) {
        await apiClient.updatePersona(selectedPersona.id, updateData);
      }

      if (avatarFile) {
        await apiClient.updatePersonaAvatar(selectedPersona.id, avatarFile);
      }
      if (voiceFile) {
        await apiClient.updatePersonaVoice(selectedPersona.id, voiceFile);
      }

      setSuccessMessage(`Persona "${formData.name}" updated successfully!`);
      setTimeout(() => setSuccessMessage(''), 3000);
      setEditDialogOpen(false);
      resetForm();
      loadPersonas();
      loadAgents();
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to update persona');
    }
  };

  const handleDeletePersona = async () => {
    if (!selectedPersona) return;

    try {
      await apiClient.deletePersona(selectedPersona.id);
      setSuccessMessage(`Persona "${selectedPersona.name}" deleted successfully!`);
      setTimeout(() => setSuccessMessage(''), 3000);
      setDeleteDialogOpen(false);
      setSelectedPersona(null);
      loadPersonas();
      loadAgents();
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to delete persona');
    }
  };

  const handleExportPersona = async (persona: Persona) => {
    try {
      const blob = await apiClient.exportPersona(persona.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${persona.name.replace(/\s+/g, '_')}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      setSuccessMessage(`Persona "${persona.name}" exported as ZIP!`);
      setTimeout(() => setSuccessMessage(''), 3000);
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to export persona');
    }
  };

  const handleImportPersona = async (file: File) => {
    try {
      const persona = await apiClient.importPersona(file);
      setSuccessMessage(`Persona "${persona.name}" imported!`);
      setTimeout(() => setSuccessMessage(''), 3000);
      loadPersonas();
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to import persona');
    }
  };

  const handlePlayVoice = (persona: Persona) => {
    if (playingVoicePersonaId === persona.id) {
      voiceAudioRef.current?.pause();
      voiceAudioRef.current = null;
      setPlayingVoicePersonaId(null);
      return;
    }
    if (voiceAudioRef.current) {
      voiceAudioRef.current.pause();
      voiceAudioRef.current = null;
    }
    const audio = new Audio(apiClient.getPersonaVoiceUrl(persona.id));
    audio.onended = () => setPlayingVoicePersonaId(null);
    audio.onerror = () => {
      setPlayingVoicePersonaId(null);
      setError('Failed to play voice reference');
    };
    audio.play();
    voiceAudioRef.current = audio;
    setPlayingVoicePersonaId(persona.id);
  };

  const resetForm = () => {
    setFormData({
      name: '',
      system_prompt: '',
      preferred_name: '',
      trigger_word: '',
    });
    setAvatarFile(null);
    setVoiceFile(null);
    setAvatarPreview(null);
    setAvatarCandidates([]);
    setSelectedPersona(null);
    setIsPromptEditorExpanded(false);
  };

  const openEditDialog = (persona: Persona) => {
    setSelectedPersona(persona);
    setFormData({
      name: persona.name,
      system_prompt: persona.system_prompt || '',
      preferred_name: persona.preferred_name || '',
      trigger_word: persona.trigger_word || '',
    });
    setAvatarPreview(persona.avatar_uuid ? apiClient.getImageUrl(persona.avatar_uuid) : null);
    setAvatarFile(null);
    setVoiceFile(null);
    setAvatarCandidates([]);
    setIsPromptEditorExpanded(false);
    setEditDialogOpen(true);
  };

  const openDeleteDialog = (persona: Persona) => {
    setSelectedPersona(persona);
    setDeleteDialogOpen(true);
  };

  const handleAvatarSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setAvatarFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setAvatarPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleVoiceSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setVoiceFile(file);
    }
  };

  const getPersonaAvatarUrl = (persona: Persona) => {
    if (persona.avatar_uuid) {
      return apiClient.getImageUrl(persona.avatar_uuid);
    }
    return undefined;
  };

  const openCharacterConfig = (persona: Persona) => {
    const linkedAgent = findLinkedAgent(persona.id);
    if (linkedAgent) {
      setCharacterConfigAgent(linkedAgent);
      setCharacterConfigOpen(true);
    } else {
      setError('Character animation requires this persona to be linked to an agent first.');
    }
  };

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 3, fontWeight: 600 }}>
        Persona Management
      </Typography>

      {/* Header actions */}
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
        <Typography variant="h6">Personas</Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Tooltip title="Refresh persona list">
            <IconButton onClick={loadPersonas} disabled={loading}>
              <RefreshIcon sx={{ animation: loading ? 'spin 1s linear infinite' : 'none', '@keyframes spin': { '0%': { transform: 'rotate(0deg)' }, '100%': { transform: 'rotate(360deg)' } } }} />
            </IconButton>
          </Tooltip>
          <Button
            variant="outlined"
            startIcon={<ImportIcon />}
            onClick={() => importInputRef.current?.click()}
          >
            Import
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept=".zip"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImportPersona(file);
              e.target.value = '';
            }}
          />
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => {
              resetForm();
              setCreateDialogOpen(true);
            }}
          >
            New Persona
          </Button>
        </Box>
      </Paper>

      {/* Alert messages */}
      {successMessage && (
        <Alert severity="success" sx={{ mb: 3, maxWidth: 1200, mx: 'auto' }}>
          {successMessage}
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mb: 3, maxWidth: 1200, mx: 'auto' }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Typography sx={{ textAlign: 'center', mt: 4 }}>Loading personas...</Typography>
      ) : personas.length === 0 ? (
        <Paper sx={{ p: 4, textAlign: 'center', maxWidth: 600, mx: 'auto' }}>
          <Typography variant="h6" gutterBottom>
            No personas yet
          </Typography>
          <Typography color="text.secondary" sx={{ mb: 3 }}>
            Create your first persona to get started. Personas define identity, voice, and personality that can be shared across agents.
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, justifyContent: 'center' }}>
            <Button
              variant="outlined"
              startIcon={<ImportIcon />}
              onClick={() => importInputRef.current?.click()}
            >
              Import
            </Button>
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => {
                resetForm();
                setCreateDialogOpen(true);
              }}
            >
              Create Persona
            </Button>
          </Box>
        </Paper>
      ) : (
        <Grid container spacing={3} sx={{ maxWidth: 1200, mx: 'auto' }}>
          <AnimatePresence>
            {personas.map((persona) => (
              <Grid item xs={12} sm={6} md={4} key={persona.id}>
                <MotionCard
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ duration: 0.3 }}
                  onClick={() => openEditDialog(persona)}
                  sx={{
                    position: 'relative',
                    border: '1px solid',
                    borderColor: 'divider',
                    cursor: 'pointer',
                    '&:hover': {
                      boxShadow: 3,
                      transform: 'translateY(-2px)',
                    },
                    transition: 'box-shadow 0.2s, transform 0.2s',
                  }}
                >
                  <CardContent sx={{ textAlign: 'center', pt: 4 }}>
                    <Avatar
                      src={getPersonaAvatarUrl(persona)}
                      sx={{
                        width: 80,
                        height: 80,
                        mx: 'auto',
                        mb: 2,
                        bgcolor: 'primary.main',
                        fontSize: '2rem',
                      }}
                    >
                      {persona.name[0]?.toUpperCase()}
                    </Avatar>
                    <Typography variant="h6" gutterBottom>
                      {persona.name}
                    </Typography>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        minHeight: 40,
                      }}
                    >
                      {persona.system_prompt || 'No personality description set'}
                    </Typography>
                    <Box sx={{ mt: 2, display: 'flex', gap: 1, justifyContent: 'center', flexWrap: 'wrap' }}>
                      {persona.voice_reference && (
                        <Chip
                          icon={<MicIcon />}
                          label={persona.voice_reference}
                          size="small"
                          variant="outlined"
                        />
                      )}
                      {persona.trigger_word && (
                        <Chip
                          label={persona.trigger_word}
                          size="small"
                          variant="outlined"
                          color="info"
                        />
                      )}
                    </Box>
                    {persona.character_config && (
                      <Box sx={{ mt: 1, display: 'flex', justifyContent: 'center' }}>
                        <Chip
                          icon={<FaceIcon />}
                          label="Character"
                          size="small"
                          variant="outlined"
                          color="success"
                        />
                      </Box>
                    )}
                  </CardContent>
                  <CardActions sx={{ justifyContent: 'center', pb: 2 }}>
                    <Tooltip title={findLinkedAgent(persona.id) ? 'Configure Character' : 'Link to an agent to configure character'}>
                      <span>
                        <IconButton
                          onClick={(e) => {
                            e.stopPropagation();
                            openCharacterConfig(persona);
                          }}
                          disabled={!findLinkedAgent(persona.id)}
                        >
                          <FaceIcon />
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip title="Export">
                      <IconButton
                        onClick={(e) => {
                          e.stopPropagation();
                          handleExportPersona(persona);
                        }}
                      >
                        <ExportIcon />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Delete">
                      <IconButton
                        onClick={(e) => {
                          e.stopPropagation();
                          openDeleteDialog(persona);
                        }}
                        color="error"
                      >
                        <DeleteIcon />
                      </IconButton>
                    </Tooltip>
                  </CardActions>
                </MotionCard>
              </Grid>
            ))}
          </AnimatePresence>
        </Grid>
      )}

      {/* Create Dialog */}
      <PersonaCreateDialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        formData={formData}
        setFormData={setFormData}
        avatarPreview={avatarPreview}
        avatarInputRef={avatarInputRef}
        handleAvatarSelect={handleAvatarSelect}
        voiceInputRef={voiceInputRef}
        handleVoiceSelect={handleVoiceSelect}
        voiceFile={voiceFile}
        handleCreatePersona={handleCreatePersona}
      />

      {/* Edit Dialog */}
      <PersonaEditDialog
        open={editDialogOpen}
        onClose={() => setEditDialogOpen(false)}
        formData={formData}
        setFormData={setFormData}
        selectedPersona={selectedPersona}
        avatarPreview={avatarPreview}
        setAvatarPreview={setAvatarPreview}
        avatarInputRef={avatarInputRef}
        handleAvatarSelect={handleAvatarSelect}
        avatarCandidates={avatarCandidates}
        setAvatarCandidates={setAvatarCandidates}
        isDetecting={isDetecting}
        setIsDetecting={setIsDetecting}
        voiceInputRef={voiceInputRef}
        handleVoiceSelect={handleVoiceSelect}
        voiceFile={voiceFile}
        playingVoicePersonaId={playingVoicePersonaId}
        handlePlayVoice={handlePlayVoice}
        isPromptEditorExpanded={isPromptEditorExpanded}
        setIsPromptEditorExpanded={setIsPromptEditorExpanded}
        findLinkedAgent={findLinkedAgent}
        openCharacterConfig={openCharacterConfig}
        handleUpdatePersona={handleUpdatePersona}
        setError={setError}
        setSuccessMessage={setSuccessMessage}
        loadPersonas={loadPersonas}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Delete Persona</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete "{selectedPersona?.name}"? This action cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" color="error" onClick={handleDeletePersona}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Character Config Dialog */}
      {characterConfigAgent && (
        <CharacterConfigDialog
          open={characterConfigOpen}
          agent={characterConfigAgent}
          onClose={() => {
            setCharacterConfigOpen(false);
            setCharacterConfigAgent(null);
          }}
          onSaved={() => {
            loadPersonas();
            loadAgents();
          }}
        />
      )}
    </Box>
  );
};
