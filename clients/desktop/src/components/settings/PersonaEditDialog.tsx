import React from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  Avatar,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Tooltip,
} from '@mui/material';
import {
  PhotoCamera as PhotoCameraIcon,
  MicNone as MicIcon,
  Badge as BadgeIcon,
  OpenInFull as OpenInFullIcon,
  CloseFullscreen as CloseFullscreenIcon,
  Tune as TuneIcon,
  Save as SaveIcon,
  Face as FaceIcon,
  AutoAwesome as AutoAwesomeIcon,
  PlayArrow as PlayIcon,
  Stop as StopIcon,
} from '@mui/icons-material';
import { CircularProgress } from '@mui/material';
import { apiClient } from '../../api/client';
import type { Persona, Agent, AvatarCandidate } from '../../api/types';

const formSectionSx = {
  p: 2.5,
  borderRadius: 2,
  border: '1px solid',
  borderColor: 'divider',
  backgroundColor: 'background.paper',
  boxShadow: 'none',
};

interface PersonaFormData {
  name: string;
  system_prompt: string;
  preferred_name: string;
  trigger_word: string;
}

interface PersonaEditDialogProps {
  open: boolean;
  onClose: () => void;
  formData: PersonaFormData;
  setFormData: React.Dispatch<React.SetStateAction<PersonaFormData>>;
  selectedPersona: Persona | null;
  avatarPreview: string | null;
  setAvatarPreview: React.Dispatch<React.SetStateAction<string | null>>;
  avatarInputRef: React.RefObject<HTMLInputElement>;
  handleAvatarSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  avatarCandidates: AvatarCandidate[];
  setAvatarCandidates: React.Dispatch<React.SetStateAction<AvatarCandidate[]>>;
  isDetecting: boolean;
  setIsDetecting: React.Dispatch<React.SetStateAction<boolean>>;
  voiceInputRef: React.RefObject<HTMLInputElement>;
  handleVoiceSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  voiceFile: File | null;
  playingVoicePersonaId: number | null;
  handlePlayVoice: (persona: Persona) => void;
  isPromptEditorExpanded: boolean;
  setIsPromptEditorExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  findLinkedAgent: (personaId: number) => Agent | null;
  openCharacterConfig: (persona: Persona) => void;
  handleUpdatePersona: () => void;
  setError: React.Dispatch<React.SetStateAction<string>>;
  setSuccessMessage: React.Dispatch<React.SetStateAction<string>>;
  loadPersonas: () => void;
}

export const PersonaEditDialog: React.FC<PersonaEditDialogProps> = ({
  open,
  onClose,
  formData,
  setFormData,
  selectedPersona,
  avatarPreview,
  setAvatarPreview,
  avatarInputRef,
  handleAvatarSelect,
  avatarCandidates,
  setAvatarCandidates,
  isDetecting,
  setIsDetecting,
  voiceInputRef,
  handleVoiceSelect,
  voiceFile,
  playingVoicePersonaId,
  handlePlayVoice,
  isPromptEditorExpanded,
  setIsPromptEditorExpanded,
  findLinkedAgent,
  openCharacterConfig,
  handleUpdatePersona,
  setError,
  setSuccessMessage,
  loadPersonas,
}) => {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{ sx: { borderRadius: 3, overflow: 'hidden' } }}
    >
      <DialogTitle
        sx={{
          px: 3,
          py: 2,
          borderBottom: '1px solid',
          borderColor: 'divider',
          backgroundColor: 'background.paper',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
          <Box>
            <Typography variant="h6">
              Edit Persona
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 520 }}>
              Refine identity, personality, voice, and appearance settings in one place.
            </Typography>
          </Box>
        </Box>
      </DialogTitle>
      <DialogContent sx={{ p: 3 }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
          {/* Avatar banner section */}
          <Box
            sx={{
              ...formSectionSx,
              p: 3,
              color: 'text.primary',
            }}
          >
            <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <Avatar
                  src={avatarPreview || undefined}
                  sx={{
                    width: 72,
                    height: 72,
                    fontSize: '1.8rem',
                    bgcolor: (t: any) => t.palette.mode === 'light' ? '#EFF6FF' : '#1A1A2E',
                    color: 'primary.main',
                  }}
                >
                  {formData.name?.[0]?.toUpperCase() || 'P'}
                </Avatar>
                <Box>
                  <Typography variant="h6" sx={{ fontWeight: 600 }}>
                    {formData.name || 'Unnamed Persona'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                    A persona defining voice, personality, and appearance.
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                    {selectedPersona?.voice_reference ? `Voice: ${selectedPersona.voice_reference}` : 'No voice reference'}
                    {selectedPersona?.character_config ? ' \u2022 Character configured' : ''}
                  </Typography>
                </Box>
              </Box>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: { xs: '100%', sm: 220 } }}>
                <input ref={avatarInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleAvatarSelect} />
                <Button
                  variant="outlined"
                  startIcon={<PhotoCameraIcon />}
                  onClick={() => avatarInputRef.current?.click()}
                  size="small"
                  sx={{ justifyContent: 'flex-start' }}
                >
                  Change Avatar
                </Button>
                {selectedPersona?.character_config && (
                  <Button
                    variant="outlined"
                    startIcon={isDetecting ? <CircularProgress size={16} /> : <AutoAwesomeIcon />}
                    onClick={async () => {
                      if (!selectedPersona) return;
                      setIsDetecting(true);
                      setAvatarCandidates([]);
                      try {
                        const candidates = await apiClient.getAvatarCandidates(selectedPersona.id);
                        setAvatarCandidates(candidates);
                        if (candidates.length === 0) setError('No faces detected in pose images');
                      } catch (err: any) {
                        setError(err.response?.data?.detail || 'Failed to detect faces');
                      } finally {
                        setIsDetecting(false);
                      }
                    }}
                    disabled={isDetecting}
                    size="small"
                    sx={{ justifyContent: 'flex-start' }}
                  >
                    {isDetecting ? 'Detecting...' : 'Detect from Poses'}
                  </Button>
                )}
              </Box>
            </Box>
            {avatarCandidates.length > 0 && (
              <Box sx={{ mt: 2.5 }}>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                  Suggested avatars from pose images
                </Typography>
                <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
                  {avatarCandidates.map((candidate) => (
                    <Tooltip key={candidate.uuid} title={`Pose: ${candidate.pose_id} (${(candidate.score * 100).toFixed(0)}%)`}>
                      <Avatar
                        src={apiClient.getImageUrl(candidate.uuid)}
                        sx={{
                          width: 64,
                          height: 64,
                          cursor: 'pointer',
                          border: '2px solid rgba(255,255,255,0.15)',
                          transition: 'border-color 0.2s, box-shadow 0.2s, transform 0.2s',
                          '&:hover': { transform: 'translateY(-1px)', borderColor: 'background.paper', boxShadow: '0 8px 24px rgba(0, 0, 0, 0.3)' },
                        }}
                        onClick={async () => {
                          if (!selectedPersona) return;
                          try {
                            await apiClient.setPersonaAvatarFromUuid(selectedPersona.id, candidate.uuid);
                            setAvatarPreview(apiClient.getImageUrl(candidate.uuid));
                            setAvatarCandidates([]);
                            setSuccessMessage('Avatar updated!');
                            setTimeout(() => setSuccessMessage(''), 3000);
                            loadPersonas();
                          } catch (err: any) {
                            setError(err.response?.data?.detail || 'Failed to set avatar');
                          }
                        }}
                      />
                    </Tooltip>
                  ))}
                </Box>
              </Box>
            )}
          </Box>

          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2.5 }}>
            {/* Identity section */}
            <Box sx={formSectionSx}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                <BadgeIcon fontSize="small" color="primary" />
                <Typography variant="h6">Identity</Typography>
              </Box>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <TextField
                  label="Persona Name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  fullWidth
                  required
                  helperText="Display name used across the app"
                />
                <TextField
                  label="Preferred Name"
                  value={formData.preferred_name}
                  onChange={(e) => setFormData({ ...formData, preferred_name: e.target.value })}
                  fullWidth
                  helperText="How this persona should address you"
                />
                <TextField
                  label="Trigger Word"
                  value={formData.trigger_word}
                  onChange={(e) => setFormData({ ...formData, trigger_word: e.target.value })}
                  fullWidth
                  helperText="Voice activation phrase for this persona"
                />
              </Box>
            </Box>

            {/* Media & Character section */}
            <Box sx={formSectionSx}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                <TuneIcon fontSize="small" color="primary" />
                <Typography variant="h6">Media & Character</Typography>
              </Box>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Box sx={{ p: 2, borderRadius: 2, backgroundColor: 'background.default', border: '1px solid', borderColor: 'divider' }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    Voice Reference
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, mb: 1.5 }}>
                    Upload a fresh voice sample or keep the current reference.
                  </Typography>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                    <input ref={voiceInputRef} type="file" accept="audio/*" style={{ display: 'none' }} onChange={handleVoiceSelect} />
                    <Button variant="outlined" startIcon={<MicIcon />} onClick={() => voiceInputRef.current?.click()} size="small">
                      Change Voice Reference
                    </Button>
                  </Box>
                  {(voiceFile || selectedPersona?.voice_reference) && (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1.25 }}>
                      <Typography variant="caption" color="text.secondary">
                        {voiceFile ? voiceFile.name : `Current: ${selectedPersona?.voice_reference}`}
                      </Typography>
                      {!voiceFile && selectedPersona?.voice_reference && (
                        <Tooltip title={playingVoicePersonaId === selectedPersona.id ? 'Stop' : 'Play'}>
                          <IconButton size="small" onClick={() => handlePlayVoice(selectedPersona)}>
                            {playingVoicePersonaId === selectedPersona.id ? <StopIcon fontSize="small" /> : <PlayIcon fontSize="small" />}
                          </IconButton>
                        </Tooltip>
                      )}
                    </Box>
                  )}
                </Box>
                <Box sx={{ p: 2, borderRadius: 2, backgroundColor: 'background.default', border: '1px solid', borderColor: 'divider' }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    Character Animation
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, mb: 1.5 }}>
                    Manage pose assets and animation graph for this persona.
                  </Typography>
                  <Tooltip title={findLinkedAgent(selectedPersona?.id ?? -1) ? '' : 'Link this persona to an agent to configure character animation'}>
                    <span>
                      <Button
                        variant="outlined"
                        startIcon={<FaceIcon />}
                        onClick={() => {
                          if (selectedPersona) {
                            openCharacterConfig(selectedPersona);
                          }
                        }}
                        size="small"
                        disabled={!selectedPersona || !findLinkedAgent(selectedPersona.id)}
                      >
                        Configure Character Animation
                        {selectedPersona?.character_config ? ' (Configured)' : ''}
                      </Button>
                    </span>
                  </Tooltip>
                </Box>
              </Box>
            </Box>
          </Box>

          {/* Personality section */}
          <Box sx={formSectionSx}>
            <Box
              sx={{
                p: 2,
                borderRadius: 2,
                backgroundColor: 'background.paper',
                border: '1px solid',
                borderColor: 'divider',
              }}
            >
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 1,
                  flexWrap: 'wrap',
                  mb: 1.5,
                }}
              >
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    Personality
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Define personality traits, speaking style, tone, and behavioral expectations.
                  </Typography>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    {formData.system_prompt.length} chars
                  </Typography>
                  <Button
                    size="small"
                    variant="text"
                    startIcon={isPromptEditorExpanded ? <CloseFullscreenIcon /> : <OpenInFullIcon />}
                    onClick={() => setIsPromptEditorExpanded((current) => !current)}
                  >
                    {isPromptEditorExpanded ? 'Compact' : 'Expand'}
                  </Button>
                </Box>
              </Box>
              <TextField
                label={isPromptEditorExpanded ? 'Personality Workspace' : 'Personality'}
                value={formData.system_prompt}
                onChange={(e) => setFormData({ ...formData, system_prompt: e.target.value })}
                multiline
                minRows={isPromptEditorExpanded ? 12 : 6}
                maxRows={isPromptEditorExpanded ? 20 : 10}
                fullWidth
                helperText="Write personality traits, speaking patterns, and behavioral guidelines in plain language."
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
            </Box>
          </Box>
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2, borderTop: '1px solid', borderColor: 'divider', justifyContent: 'space-between' }}>
        <Typography variant="caption" color="text.secondary" sx={{ mr: 2 }}>
          Changes apply immediately after saving.
        </Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            onClick={handleUpdatePersona}
            disabled={!formData.name.trim()}
          >
            Save Changes
          </Button>
        </Box>
      </DialogActions>
    </Dialog>
  );
};
