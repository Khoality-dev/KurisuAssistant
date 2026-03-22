import React, { useState, useEffect } from 'react';
import {
  Box,
  Paper,
  Typography,
  IconButton,
  Card,
  CardContent,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  CircularProgress,
  TextField,
} from '@mui/material';
import {
  AutoFixHigh as SkillIcon,
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  FileUpload as ImportIcon,
  FileDownload as ExportIcon,
} from '@mui/icons-material';
import { motion, AnimatePresence } from 'framer-motion';
import { apiClient } from '../../api/client';
import type { Skill } from '../../api/types';

const MotionCard = motion(Card);

export const SkillsSection: React.FC = () => {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Skill editor state
  const [skillDialogOpen, setSkillDialogOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const [skillName, setSkillName] = useState('');
  const [skillInstructions, setSkillInstructions] = useState('');
  const [skillSaving, setSkillSaving] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const skillsRes = await apiClient.listSkills();
      setSkills(skillsRes);
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to load skills');
    } finally {
      setLoading(false);
    }
  };

  // Skill handlers

  const handleNewSkill = () => {
    setEditingSkill(null);
    setSkillName('');
    setSkillInstructions('');
    setSkillDialogOpen(true);
  };

  const handleEditSkill = (skill: Skill) => {
    setEditingSkill(skill);
    setSkillName(skill.name);
    setSkillInstructions(skill.instructions);
    setSkillDialogOpen(true);
  };

  const handleSaveSkill = async () => {
    if (!skillName.trim()) return;
    setSkillSaving(true);
    try {
      if (editingSkill) {
        await apiClient.updateSkill(editingSkill.id, {
          name: skillName,
          instructions: skillInstructions,
        });
      } else {
        await apiClient.createSkill({
          name: skillName,
          instructions: skillInstructions,
        });
      }
      setSkillDialogOpen(false);
      const skillsRes = await apiClient.listSkills();
      setSkills(skillsRes);
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to save skill');
    } finally {
      setSkillSaving(false);
    }
  };

  const handleDeleteSkill = async (skill: Skill) => {
    try {
      await apiClient.deleteSkill(skill.id);
      setSkills(prev => prev.filter(s => s.id !== skill.id));
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to delete skill');
    }
  };

  const handleExportSkill = (skill: Skill) => {
    const exportData = {
      name: skill.name,
      instructions: skill.instructions,
      version: 1,
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${skill.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.skill.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportSkill = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.skill.json';
    input.multiple = true;
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files) return;

      for (const file of Array.from(files)) {
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          if (!data.name || typeof data.name !== 'string') {
            setError(`Invalid skill file: ${file.name} — missing "name" field`);
            continue;
          }
          await apiClient.createSkill({
            name: data.name,
            instructions: data.instructions || '',
          });
        } catch (err: any) {
          setError(err.response?.data?.detail || err.message || `Failed to import ${file.name}`);
        }
      }
      const skillsRes = await apiClient.listSkills();
      setSkills(skillsRes);
    };
    input.click();
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h5" gutterBottom fontWeight={600}>
        Skills
      </Typography>

      {error && (
        <Box sx={{ mb: 2, color: 'error.main' }}>
          <Typography variant="body2">{error}</Typography>
        </Box>
      )}

      <Box sx={{ maxWidth: 900, mx: 'auto' }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
          <Box>
            <Typography variant="body2" color="text.secondary">
              Skills are instructions injected into every agent's system prompt, teaching the LLM when and how to use its capabilities.
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 1, ml: 2, flexShrink: 0 }}>
            <Button
              variant="outlined"
              startIcon={<ImportIcon />}
              onClick={handleImportSkill}
            >
              Import
            </Button>
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={handleNewSkill}
            >
              New Skill
            </Button>
          </Box>
        </Box>

        {skills.length === 0 ? (
          <Paper sx={{ p: 4, textAlign: 'center' }}>
            <SkillIcon sx={{ fontSize: 48, color: 'text.disabled', mb: 2 }} />
            <Typography variant="h6" gutterBottom>
              No Skills Defined
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 2 }}>
              Create skills to teach your agents new capabilities. For example, create a "Music Player" skill
              with instructions on when and how to use the play_music tool.
            </Typography>
            <Button variant="outlined" startIcon={<AddIcon />} onClick={handleNewSkill}>
              Create Your First Skill
            </Button>
          </Paper>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <AnimatePresence>
              {skills.map((skill, index) => (
                <MotionCard
                  key={skill.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ duration: 0.3, delay: index * 0.05 }}
                  sx={{
                    border: '1px solid',
                    borderColor: 'divider',
                  }}
                >
                  <CardContent>
                    <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                      <Box sx={{ flex: 1, mr: 2 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                          <SkillIcon fontSize="small" color="primary" />
                          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                            {skill.name}
                          </Typography>
                        </Box>
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          sx={{
                            whiteSpace: 'pre-wrap',
                            fontFamily: 'monospace',
                            fontSize: '0.8rem',
                            backgroundColor: '#f5f5f5',
                            p: 1.5,
                            borderRadius: 1,
                            maxHeight: 200,
                            overflow: 'auto',
                          }}
                        >
                          {skill.instructions || '(no instructions)'}
                        </Typography>
                      </Box>
                      <Box sx={{ display: 'flex', gap: 0.5, flexShrink: 0 }}>
                        <IconButton size="small" onClick={() => handleExportSkill(skill)} title="Export">
                          <ExportIcon fontSize="small" />
                        </IconButton>
                        <IconButton size="small" onClick={() => handleEditSkill(skill)} title="Edit">
                          <EditIcon fontSize="small" />
                        </IconButton>
                        <IconButton size="small" onClick={() => handleDeleteSkill(skill)} title="Delete" color="error">
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Box>
                    </Box>
                  </CardContent>
                </MotionCard>
              ))}
            </AnimatePresence>
          </Box>
        )}
      </Box>

      {/* Skill Editor Dialog */}
      <Dialog
        open={skillDialogOpen}
        onClose={() => setSkillDialogOpen(false)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          {editingSkill ? 'Edit Skill' : 'New Skill'}
        </DialogTitle>
        <DialogContent dividers>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, pt: 1 }}>
            <TextField
              label="Skill Name"
              value={skillName}
              onChange={(e) => setSkillName(e.target.value)}
              fullWidth
              placeholder="e.g., Music Player"
            />
            <TextField
              label="Instructions"
              value={skillInstructions}
              onChange={(e) => setSkillInstructions(e.target.value)}
              fullWidth
              multiline
              minRows={6}
              maxRows={16}
              placeholder={
                'Write instructions that teach the LLM how to use this capability.\n\n' +
                'Example:\n' +
                'You have access to a music player that can stream audio from YouTube.\n' +
                '- When the user asks to play a song, use the `play_music` tool.\n' +
                '- Use `music_control` to pause, resume, skip, or stop.\n' +
                '- Use `get_music_queue` to check what\'s playing.'
              }
              helperText="These instructions are injected into every agent's system prompt."
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSkillDialogOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleSaveSkill}
            disabled={!skillName.trim() || skillSaving}
          >
            {skillSaving ? <CircularProgress size={20} /> : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};
