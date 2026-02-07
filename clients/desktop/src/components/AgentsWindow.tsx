import React, { useState, useEffect, useRef } from 'react';
import {
  Box,
  Paper,
  Typography,
  TextField,
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
  FormControl,
  FormControlLabel,
  InputLabel,
  Select,
  Switch,
  MenuItem,
  Autocomplete,
  Checkbox,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  PhotoCamera as PhotoCameraIcon,
  MicNone as MicIcon,
  Save as SaveIcon,
  Refresh as RefreshIcon,
  Settings as SettingsIcon,
  Extension as ExtensionIcon,
} from '@mui/icons-material';
import { motion, AnimatePresence } from 'framer-motion';
import { apiClient } from '../api/client';
import type { Agent, AgentCreate, AgentUpdate, Tool } from '../api/types';

const MotionCard = motion(Card);

// Internal tools that shouldn't be assignable to user agents
const INTERNAL_TOOLS = ['route_to_agent', 'route_to_user'];

interface AgentFormData {
  name: string;
  system_prompt: string;
  model_name: string;
  think: boolean;
  tools: string[];
}

export const AgentsWindow: React.FC = () => {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [availableTools, setAvailableTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(true);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  // Dialog states
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);

  // Form data
  const [formData, setFormData] = useState<AgentFormData>({
    name: '',
    system_prompt: '',
    model_name: '',
    think: false,
    tools: [],
  });

  // File upload refs
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const voiceInputRef = useRef<HTMLInputElement>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);

  useEffect(() => {
    loadAgents();
    loadModels();
    loadTools();
  }, []);

  const loadModels = async () => {
    try {
      setModelsLoading(true);
      const data = await apiClient.getModels();
      setModels(data);
    } catch (err: any) {
      console.error('Failed to load models:', err);
      setError('Failed to load models from Ollama');
    } finally {
      setModelsLoading(false);
    }
  };

  const loadTools = async () => {
    try {
      const data = await apiClient.listTools();
      const allTools = [...data.mcp_tools, ...data.builtin_tools]
        .filter(t => !INTERNAL_TOOLS.includes(t.function.name));
      setAvailableTools(allTools);
    } catch (err: any) {
      console.error('Failed to load tools:', err);
    }
  };

  const loadAgents = async () => {
    try {
      setLoading(true);
      const data = await apiClient.listAgents();
      setAgents(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load agents');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateAgent = async () => {
    try {
      const createData: AgentCreate = {
        name: formData.name,
        system_prompt: formData.system_prompt || undefined,
        model_name: formData.model_name,
        think: formData.think,
        tools: formData.tools.length > 0 ? formData.tools : undefined,
      };

      const newAgent = await apiClient.createAgent(createData);

      // Upload avatar if selected
      if (avatarFile) {
        await apiClient.updateAgentAvatar(newAgent.id, avatarFile);
      }

      // Upload voice if selected
      if (voiceFile) {
        await apiClient.updateAgentVoice(newAgent.id, voiceFile);
      }

      setSuccessMessage(`Agent "${newAgent.name}" created successfully!`);
      setTimeout(() => setSuccessMessage(''), 3000);
      setCreateDialogOpen(false);
      resetForm();
      loadAgents();
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to create agent');
    }
  };

  const handleUpdateAgent = async () => {
    if (!selectedAgent) return;

    try {
      const toolsChanged = JSON.stringify(formData.tools) !== JSON.stringify(selectedAgent.tools || []);
      const updateData: AgentUpdate = {
        name: formData.name !== selectedAgent.name ? formData.name : undefined,
        system_prompt: formData.system_prompt !== selectedAgent.system_prompt ? formData.system_prompt : undefined,
        model_name: formData.model_name !== selectedAgent.model_name ? formData.model_name : undefined,
        think: formData.think !== selectedAgent.think ? formData.think : undefined,
        tools: toolsChanged ? formData.tools : undefined,
      };

      // Only send fields that changed
      const hasChanges = Object.values(updateData).some(v => v !== undefined);
      if (hasChanges) {
        await apiClient.updateAgent(selectedAgent.id, updateData);
      }

      // Upload avatar if selected
      if (avatarFile) {
        await apiClient.updateAgentAvatar(selectedAgent.id, avatarFile);
      }

      // Upload voice if selected
      if (voiceFile) {
        await apiClient.updateAgentVoice(selectedAgent.id, voiceFile);
      }

      setSuccessMessage(`Agent "${formData.name}" updated successfully!`);
      setTimeout(() => setSuccessMessage(''), 3000);
      setEditDialogOpen(false);
      resetForm();
      loadAgents();
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to update agent');
    }
  };

  const handleDeleteAgent = async () => {
    if (!selectedAgent) return;

    try {
      await apiClient.deleteAgent(selectedAgent.id);
      setSuccessMessage(`Agent "${selectedAgent.name}" deleted successfully!`);
      setTimeout(() => setSuccessMessage(''), 3000);
      setDeleteDialogOpen(false);
      setSelectedAgent(null);
      loadAgents();
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to delete agent');
    }
  };

  const resetForm = () => {
    setFormData({
      name: '',
      system_prompt: '',
      model_name: '',
      think: false,
      tools: [],
    });
    setAvatarFile(null);
    setVoiceFile(null);
    setAvatarPreview(null);
    setSelectedAgent(null);
  };

  const openEditDialog = (agent: Agent) => {
    setSelectedAgent(agent);
    setFormData({
      name: agent.name,
      system_prompt: agent.system_prompt || '',
      model_name: agent.model_name || '',
      think: agent.think,
      tools: agent.tools || [],
    });
    if (agent.avatar_uuid) {
      setAvatarPreview(apiClient.getImageUrl(agent.avatar_uuid));
    }
    setEditDialogOpen(true);
  };

  const openDeleteDialog = (agent: Agent) => {
    setSelectedAgent(agent);
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

  const getAgentAvatarUrl = (agent: Agent) => {
    if (agent.avatar_uuid) {
      return apiClient.getImageUrl(agent.avatar_uuid);
    }
    return undefined;
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <Paper
        elevation={0}
        sx={{
          p: 2,
          borderBottom: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Typography variant="h6">Agents</Typography>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => {
            resetForm();
            setCreateDialogOpen(true);
          }}
        >
          New Agent
        </Button>
      </Paper>

      {/* Content */}
      <Box sx={{ flex: 1, overflow: 'auto', p: 3, backgroundColor: '#F7F7F8' }}>
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
          <Typography sx={{ textAlign: 'center', mt: 4 }}>Loading agents...</Typography>
        ) : agents.length === 0 ? (
          <Paper sx={{ p: 4, textAlign: 'center', maxWidth: 600, mx: 'auto' }}>
            <Typography variant="h6" gutterBottom>
              No agents yet
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 3 }}>
              Create your first agent to get started. Agents can have custom personalities, voices, and avatars.
            </Typography>
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => {
                resetForm();
                setCreateDialogOpen(true);
              }}
            >
              Create Agent
            </Button>
          </Paper>
        ) : (
          <Grid container spacing={3} sx={{ maxWidth: 1200, mx: 'auto' }}>
            <AnimatePresence>
              {agents.map((agent) => (
                <Grid item xs={12} sm={6} md={4} key={agent.id}>
                  <MotionCard
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -20 }}
                    transition={{ duration: 0.3 }}
                    onClick={() => openEditDialog(agent)}
                    sx={{
                      position: 'relative',
                      border: agent.name === 'Administrator' ? '2px solid' : '1px solid',
                      borderColor: agent.name === 'Administrator' ? 'secondary.main' : 'divider',
                      cursor: 'pointer',
                      '&:hover': {
                        boxShadow: 3,
                        transform: 'translateY(-2px)',
                      },
                      transition: 'box-shadow 0.2s, transform 0.2s',
                    }}
                  >
                    {agent.name === 'Administrator' && (
                      <Chip
                        label="System"
                        color="secondary"
                        size="small"
                        icon={<SettingsIcon />}
                        sx={{ position: 'absolute', top: 12, right: 12 }}
                      />
                    )}
                    <CardContent sx={{ textAlign: 'center', pt: 4 }}>
                      <Avatar
                        src={getAgentAvatarUrl(agent)}
                        sx={{
                          width: 80,
                          height: 80,
                          mx: 'auto',
                          mb: 2,
                          bgcolor: 'primary.main',
                          fontSize: '2rem',
                        }}
                      >
                        {agent.name[0]?.toUpperCase()}
                      </Avatar>
                      <Typography variant="h6" gutterBottom>
                        {agent.name}
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
                        {agent.system_prompt || 'No system prompt set'}
                      </Typography>
                      <Box sx={{ mt: 2, display: 'flex', gap: 1, justifyContent: 'center', flexWrap: 'wrap' }}>
                        {agent.voice_reference && (
                          <Chip
                            icon={<MicIcon />}
                            label={agent.voice_reference}
                            size="small"
                            variant="outlined"
                          />
                        )}
                        {agent.model_name && (
                          <Chip label={agent.model_name} size="small" variant="outlined" />
                        )}
                      </Box>
                      {agent.tools && agent.tools.length > 0 && (
                        <Box sx={{ mt: 1, display: 'flex', gap: 0.5, justifyContent: 'center', flexWrap: 'wrap' }}>
                          {agent.tools.slice(0, 3).map(tool => (
                            <Chip
                              key={tool}
                              icon={<ExtensionIcon />}
                              label={tool}
                              size="small"
                              variant="outlined"
                              color="primary"
                            />
                          ))}
                          {agent.tools.length > 3 && (
                            <Chip
                              label={`+${agent.tools.length - 3} more`}
                              size="small"
                              variant="outlined"
                            />
                          )}
                        </Box>
                      )}
                    </CardContent>
                    <CardActions sx={{ justifyContent: 'center', pb: 2 }}>
                      {agent.name !== 'Administrator' && (
                        <Tooltip title="Delete">
                          <IconButton
                            onClick={(e) => {
                              e.stopPropagation();
                              openDeleteDialog(agent);
                            }}
                            color="error"
                          >
                            <DeleteIcon />
                          </IconButton>
                        </Tooltip>
                      )}
                    </CardActions>
                  </MotionCard>
                </Grid>
              ))}
            </AnimatePresence>
          </Grid>
        )}
      </Box>

      {/* Create Dialog */}
      <Dialog open={createDialogOpen} onClose={() => setCreateDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Create New Agent</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, mt: 1 }}>
            {/* Avatar */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Avatar
                src={avatarPreview || undefined}
                sx={{ width: 80, height: 80, bgcolor: 'primary.main', fontSize: '2rem' }}
              >
                {formData.name?.[0]?.toUpperCase() || 'A'}
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
              label="Agent Name"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              fullWidth
              required
              helperText="A unique name for this agent (e.g., 'Kurisu')"
            />

            {/* System Prompt */}
            <TextField
              label="System Prompt"
              value={formData.system_prompt}
              onChange={(e) => setFormData({ ...formData, system_prompt: e.target.value })}
              multiline
              rows={4}
              fullWidth
              helperText="Define the agent's personality and behavior"
            />

            {/* Model */}
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
              <FormControl fullWidth required>
                <InputLabel>Model</InputLabel>
                <Select
                  value={formData.model_name}
                  label="Model"
                  onChange={(e) => setFormData({ ...formData, model_name: e.target.value })}
                >
                  {models.map((model) => (
                    <MenuItem key={model} value={model}>
                      {model}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Tooltip title="Refresh model list from Ollama">
                <IconButton
                  onClick={loadModels}
                  disabled={modelsLoading}
                  sx={{ mt: 1 }}
                >
                  <RefreshIcon sx={{ animation: modelsLoading ? 'spin 1s linear infinite' : 'none', '@keyframes spin': { '0%': { transform: 'rotate(0deg)' }, '100%': { transform: 'rotate(360deg)' } } }} />
                </IconButton>
              </Tooltip>
            </Box>

            {/* Thinking */}
            <FormControlLabel
              control={
                <Switch
                  checked={formData.think}
                  onChange={(e) => setFormData({ ...formData, think: e.target.checked })}
                />
              }
              label="Enable extended thinking"
            />

            {/* Tools */}
            <Autocomplete
              multiple
              options={availableTools.map(t => t.function.name)}
              value={formData.tools}
              onChange={(_, newValue) => setFormData({ ...formData, tools: newValue })}
              disableCloseOnSelect
              renderOption={(props, option, { selected }) => {
                const tool = availableTools.find(t => t.function.name === option);
                return (
                  <li {...props}>
                    <Checkbox checked={selected} size="small" sx={{ mr: 1 }} />
                    <Box>
                      <Typography variant="body2">{option}</Typography>
                      {tool?.function.description && (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                          {tool.function.description.length > 80
                            ? tool.function.description.slice(0, 80) + '...'
                            : tool.function.description}
                        </Typography>
                      )}
                    </Box>
                  </li>
                );
              }}
              renderTags={(value, getTagProps) =>
                value.map((option, index) => (
                  <Chip {...getTagProps({ index })} key={option} label={option} size="small" icon={<ExtensionIcon />} />
                ))
              }
              renderInput={(params) => (
                <TextField {...params} label="Tools" placeholder="Select tools..." helperText="Tools this agent can use" />
              )}
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
          <Button onClick={() => setCreateDialogOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            onClick={handleCreateAgent}
            disabled={!formData.name.trim() || !formData.model_name}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editDialogOpen} onClose={() => setEditDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Edit Agent</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, mt: 1 }}>
            {/* Avatar */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Avatar
                src={avatarPreview || undefined}
                sx={{ width: 80, height: 80, bgcolor: 'primary.main', fontSize: '2rem' }}
              >
                {formData.name?.[0]?.toUpperCase() || 'A'}
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
                Change Avatar
              </Button>
            </Box>

            {/* Name */}
            <TextField
              label="Agent Name"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              fullWidth
              required
              disabled={selectedAgent?.name === 'Administrator'}
              helperText={selectedAgent?.name === 'Administrator' ? 'Administrator name cannot be changed' : undefined}
            />

            {/* System Prompt */}
            <TextField
              label="System Prompt"
              value={selectedAgent?.name === 'Administrator' ? 'System agent for routing conversations' : formData.system_prompt}
              onChange={(e) => setFormData({ ...formData, system_prompt: e.target.value })}
              multiline
              rows={4}
              fullWidth
              disabled={selectedAgent?.name === 'Administrator'}
              helperText={selectedAgent?.name === 'Administrator' ? 'Administrator uses built-in routing logic' : undefined}
            />

            {/* Model */}
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
              <FormControl fullWidth required>
                <InputLabel>Model</InputLabel>
                <Select
                  value={formData.model_name}
                  label="Model"
                  onChange={(e) => setFormData({ ...formData, model_name: e.target.value })}
                >
                  {models.map((model) => (
                    <MenuItem key={model} value={model}>
                      {model}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Tooltip title="Refresh model list from Ollama">
                <IconButton
                  onClick={loadModels}
                  disabled={modelsLoading}
                  sx={{ mt: 1 }}
                >
                  <RefreshIcon sx={{ animation: modelsLoading ? 'spin 1s linear infinite' : 'none', '@keyframes spin': { '0%': { transform: 'rotate(0deg)' }, '100%': { transform: 'rotate(360deg)' } } }} />
                </IconButton>
              </Tooltip>
            </Box>

            {/* Thinking */}
            <FormControlLabel
              control={
                <Switch
                  checked={formData.think}
                  onChange={(e) => setFormData({ ...formData, think: e.target.checked })}
                />
              }
              label="Enable extended thinking"
            />

            {/* Tools */}
            <Autocomplete
              multiple
              options={availableTools.map(t => t.function.name)}
              value={formData.tools}
              onChange={(_, newValue) => setFormData({ ...formData, tools: newValue })}
              disableCloseOnSelect
              renderOption={(props, option, { selected }) => {
                const tool = availableTools.find(t => t.function.name === option);
                return (
                  <li {...props}>
                    <Checkbox checked={selected} size="small" sx={{ mr: 1 }} />
                    <Box>
                      <Typography variant="body2">{option}</Typography>
                      {tool?.function.description && (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                          {tool.function.description.length > 80
                            ? tool.function.description.slice(0, 80) + '...'
                            : tool.function.description}
                        </Typography>
                      )}
                    </Box>
                  </li>
                );
              }}
              renderTags={(value, getTagProps) =>
                value.map((option, index) => (
                  <Chip {...getTagProps({ index })} key={option} label={option} size="small" icon={<ExtensionIcon />} />
                ))
              }
              renderInput={(params) => (
                <TextField {...params} label="Tools" placeholder="Select tools..." helperText="Tools this agent can use" />
              )}
            />

            {/* Voice Reference */}
            <Box>
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
                  Change Voice Reference
                </Button>
                {voiceFile && (
                  <Typography variant="body2" color="text.secondary">
                    {voiceFile.name}
                  </Typography>
                )}
              </Box>
              {selectedAgent?.voice_reference && !voiceFile && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  Current: {selectedAgent.voice_reference}
                </Typography>
              )}
            </Box>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditDialogOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            onClick={handleUpdateAgent}
            disabled={!formData.name.trim() || !formData.model_name}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Delete Agent</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete "{selectedAgent?.name}"? This action cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" color="error" onClick={handleDeleteAgent}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};
