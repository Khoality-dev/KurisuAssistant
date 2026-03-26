import React from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  Avatar,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/material';
import {
  PhotoCamera as PhotoCameraIcon,
  MicNone as MicIcon,
  Save as SaveIcon,
} from '@mui/icons-material';

interface PersonaFormData {
  name: string;
  system_prompt: string;
  preferred_name: string;
  trigger_word: string;
}

interface PersonaCreateDialogProps {
  open: boolean;
  onClose: () => void;
  formData: PersonaFormData;
  setFormData: React.Dispatch<React.SetStateAction<PersonaFormData>>;
  avatarPreview: string | null;
  avatarInputRef: React.RefObject<HTMLInputElement>;
  handleAvatarSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  voiceInputRef: React.RefObject<HTMLInputElement>;
  handleVoiceSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  voiceFile: File | null;
  handleCreatePersona: () => void;
}

export const PersonaCreateDialog: React.FC<PersonaCreateDialogProps> = ({
  open,
  onClose,
  formData,
  setFormData,
  avatarPreview,
  avatarInputRef,
  handleAvatarSelect,
  voiceInputRef,
  handleVoiceSelect,
  voiceFile,
  handleCreatePersona,
}) => {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Create New Persona</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, mt: 1 }}>
          {/* Avatar */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Avatar
              src={avatarPreview || undefined}
              sx={{ width: 80, height: 80, bgcolor: 'primary.main', fontSize: '2rem' }}
            >
              {formData.name?.[0]?.toUpperCase() || 'P'}
            </Avatar>
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={handleAvatarSelect}
            />
            <Button
              variant="outlined"
              startIcon={<PhotoCameraIcon />}
              onClick={() => avatarInputRef.current?.click()}
            >
              Upload Avatar
            </Button>
          </Box>

          {/* Name */}
          <TextField
            label="Persona Name"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            fullWidth
            required
            helperText="A unique name for this persona (e.g., 'Kurisu')"
          />

          {/* System Prompt (personality) */}
          <TextField
            label="Personality"
            value={formData.system_prompt}
            onChange={(e) => setFormData({ ...formData, system_prompt: e.target.value })}
            multiline
            rows={4}
            fullWidth
            helperText="Define the persona's personality and behavior"
          />

          {/* Preferred Name */}
          <TextField
            label="Preferred Name"
            value={formData.preferred_name}
            onChange={(e) => setFormData({ ...formData, preferred_name: e.target.value })}
            fullWidth
            helperText="How this persona should address you"
          />

          {/* Trigger Word */}
          <TextField
            label="Trigger Word"
            value={formData.trigger_word}
            onChange={(e) => setFormData({ ...formData, trigger_word: e.target.value })}
            fullWidth
            helperText="Say this word to activate voice interaction mode (e.g., persona's name)"
          />

          {/* Voice Reference */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <input
              ref={voiceInputRef}
              type="file"
              accept="audio/*"
              style={{ display: 'none' }}
              onChange={handleVoiceSelect}
            />
            <Button
              variant="outlined"
              startIcon={<MicIcon />}
              onClick={() => voiceInputRef.current?.click()}
            >
              Upload Voice Reference
            </Button>
            {voiceFile && (
              <Typography variant="body2" color="text.secondary">
                {voiceFile.name}
              </Typography>
            )}
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          startIcon={<SaveIcon />}
          onClick={handleCreatePersona}
          disabled={!formData.name.trim()}
        >
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
};
