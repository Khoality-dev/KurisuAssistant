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
  FormControlLabel,
  Switch,
  Autocomplete,
  Checkbox,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  PhotoCamera as PhotoCameraIcon,
  MicNone as MicIcon,
  Badge as BadgeIcon,
  OpenInFull as OpenInFullIcon,
  CloseFullscreen as CloseFullscreenIcon,
  PsychologyAlt as PsychologyIcon,
  Tune as TuneIcon,
  Save as SaveIcon,
  Refresh as RefreshIcon,
  Settings as SettingsIcon,
  Extension as ExtensionIcon,
  Face as FaceIcon,
  AutoAwesome as AutoAwesomeIcon,
} from '@mui/icons-material';
import { CircularProgress } from '@mui/material';
import { motion, AnimatePresence } from 'framer-motion';
import { apiClient } from '../../api/client';
import { useAgentStore } from '../../store/agentStore';
import { storage } from '../../utils/storage';
import type { Agent, AgentCreate, AgentUpdate, Tool, AvatarCandidate } from '../../api/types';
import { CharacterConfigDialog } from '../CharacterConfigDialog';
import { ModelPicker } from '../ModelPicker';

const MotionCard = motion(Card);

// Internal tools that shouldn't appear in the exclusion list
const INTERNAL_TOOLS = ['route_to_agent', 'route_to_user', 'play_music', 'music_control', 'get_music_queue'];
const formSectionSx = {
  p: 2.5,
  borderRadius: 2,
  border: '1px solid',
  borderColor: 'divider',
  backgroundColor: 'background.paper',
  boxShadow: 'none',
};


interface AgentFormData {
  name: string;
  system_prompt: string;
  model_name: string;
  think: boolean;
  excluded_tools: string[];
  memory: string;
  memory_enabled: boolean;
  preferred_name: string;
  trigger_word: string;
}

export const AgentsSection: React.FC = () => {
  const { loadAgents: refreshAgentStore } = useAgentStore();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [models, setModels] = useState<Array<{ name: string; provider: string }>>([]);
  const [availableTools, setAvailableTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  // Dialog states
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [characterConfigOpen, setCharacterConfigOpen] = useState(false);
  const [characterConfigAgent, setCharacterConfigAgent] = useState<Agent | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);

  // Form data
  const [formData, setFormData] = useState<AgentFormData>({
    name: '',
    system_prompt: '',
    model_name: '',
    think: false,
    excluded_tools: [],
    memory: '',
    memory_enabled: true,
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

  useEffect(() => {
    loadAgents();
    loadModels();
    loadTools();
  }, []);

  const loadModels = async () => {
    try {
      const data = await apiClient.getModels();
      setModels(data);
    } catch (err: any) {
      console.error('Failed to load models:', err);
      setError('Failed to load models from Ollama');
    }
  };

  const loadTools = async () => {
    try {
      const data = await apiClient.listTools();
      const allTools: Tool[] = [...data.mcp_tools, ...data.builtin_tools];
      // Add client-side tools (host, app, browser) from Electron IPC
      if (window.electron?.hostTools) {
        try { allTools.push(...(await window.electron.hostTools.listTools() as Tool[])); } catch {}
      }
      if (window.electron?.appTools) {
        try { allTools.push(...(await window.electron.appTools.listTools() as Tool[])); } catch {}
      }
      // Deduplicate by name and filter internal tools
      const seen = new Set<string>();
      const uniqueTools = allTools.filter(t => {
        const name = t.function.name;
        if (seen.has(name) || INTERNAL_TOOLS.includes(name)) return false;
        seen.add(name);
        return true;
      });
      setAvailableTools(uniqueTools);
    } catch (err: any) {
      console.error('Failed to load tools:', err);
    }
  };

  const loadAgents = async () => {
    try {
      setLoading(true);
      const data = await apiClient.listAgents();
      setAgents(data);
      // Also refresh the shared agent store (sidebar selector)
      refreshAgentStore();
    } catch (err: any) {
      setError(err.message || 'Failed to load agents');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateAgent = async () => {
    try {
      const modelName = formData.model_name.trim();
      const provider = models.find(m => m.name === modelName)?.provider || 'ollama';
      const createData: AgentCreate = {
        name: formData.name,
        system_prompt: formData.system_prompt || undefined,
        model_name: modelName,
        provider_type: provider,
        think: formData.think,
        excluded_tools: formData.excluded_tools.length > 0 ? formData.excluded_tools : undefined,
        preferred_name: formData.preferred_name.trim() || undefined,
        trigger_word: formData.trigger_word.trim() || undefined,
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
      const toolsChanged = JSON.stringify(formData.excluded_tools) !== JSON.stringify(selectedAgent.excluded_tools || []);
      const normalizedModelName = formData.model_name.trim();
      const updateData: AgentUpdate = {
        name: formData.name !== selectedAgent.name ? formData.name : undefined,
        system_prompt: formData.system_prompt !== selectedAgent.system_prompt ? formData.system_prompt : undefined,
        model_name: normalizedModelName !== (selectedAgent.model_name || '') ? normalizedModelName : undefined,
        provider_type: (() => { const p = models.find(m => m.name === normalizedModelName)?.provider || 'ollama'; return p !== (selectedAgent.provider_type || 'ollama') ? p : undefined; })(),
        think: formData.think !== selectedAgent.think ? formData.think : undefined,
        excluded_tools: toolsChanged ? formData.excluded_tools : undefined,
        memory: formData.memory !== (selectedAgent.memory || '') ? formData.memory : undefined,
        memory_enabled: formData.memory_enabled !== selectedAgent.memory_enabled ? formData.memory_enabled : undefined,
        preferred_name: formData.preferred_name !== (selectedAgent.preferred_name || '') ? (formData.preferred_name.trim() || '') : undefined,
        trigger_word: formData.trigger_word !== (selectedAgent.trigger_word || '') ? (formData.trigger_word.trim() || '') : undefined,
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
      storage.clearAgentConversationId(selectedAgent.id);
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
      excluded_tools: [],
      memory: '',
      memory_enabled: true,
      preferred_name: '',
      trigger_word: '',
    });
    setAvatarFile(null);
    setVoiceFile(null);
    setAvatarPreview(null);
    setAvatarCandidates([]);
    setSelectedAgent(null);
    setIsPromptEditorExpanded(false);
  };

  const openEditDialog = (agent: Agent) => {
    setSelectedAgent(agent);
    setFormData({
      name: agent.name,
      system_prompt: agent.system_prompt || '',
      model_name: agent.model_name || '',
      think: agent.think,
      excluded_tools: agent.excluded_tools || [],
      memory: agent.memory || '',
      memory_enabled: agent.memory_enabled,
      preferred_name: agent.preferred_name || '',
      trigger_word: agent.trigger_word || '',
    });
    setAvatarPreview(agent.avatar_uuid ? apiClient.getImageUrl(agent.avatar_uuid) : null);
    setAvatarFile(null);
    setVoiceFile(null);
    setAvatarCandidates([]);
    setIsPromptEditorExpanded(false);
    setEditDialogOpen(true);
    loadTools();
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

  const isAdministrator = selectedAgent?.name === 'Administrator';

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 3, fontWeight: 600 }}>
        Agent Management
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
        <Typography variant="h6">Agents</Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Tooltip title="Refresh agent list">
            <IconButton onClick={loadAgents} disabled={loading}>
              <RefreshIcon sx={{ animation: loading ? 'spin 1s linear infinite' : 'none', '@keyframes spin': { '0%': { transform: 'rotate(0deg)' }, '100%': { transform: 'rotate(360deg)' } } }} />
            </IconButton>
          </Tooltip>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => {
              resetForm();
              setCreateDialogOpen(true);
              loadTools();
            }}
          >
            New Agent
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
              loadTools();
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
                    {agent.excluded_tools && agent.excluded_tools.length > 0 && (
                      <Box sx={{ mt: 1, display: 'flex', gap: 0.5, justifyContent: 'center', flexWrap: 'wrap' }}>
                        {agent.excluded_tools.slice(0, 3).map(tool => (
                          <Chip
                            key={tool}
                            icon={<ExtensionIcon />}
                            label={tool}
                            size="small"
                            variant="outlined"
                            color="default"
                            sx={{ textDecoration: 'line-through', opacity: 0.7 }}
                          />
                        ))}
                        {agent.excluded_tools.length > 3 && (
                          <Chip
                            label={`+${agent.excluded_tools.length - 3} more`}
                            size="small"
                            variant="outlined"
                          />
                        )}
                      </Box>
                    )}
                    {agent.character_config && (
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
                    <Tooltip title="Configure Character">
                      <IconButton
                        onClick={(e) => {
                          e.stopPropagation();
                          setCharacterConfigAgent(agent);
                          setCharacterConfigOpen(true);
                        }}
                      >
                        <FaceIcon />
                      </IconButton>
                    </Tooltip>
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
            <ModelPicker
              label="Model"
              value={formData.model_name}
              models={models}
              onChange={(model_name) => setFormData({ ...formData, model_name })}
              onRefresh={loadModels}
              onSuccess={(message) => {
                setSuccessMessage(message);
                setTimeout(() => setSuccessMessage(''), 3000);
              }}
              onError={setError}
              required
            />

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
              value={formData.excluded_tools}
              onChange={(_, newValue) => setFormData({ ...formData, excluded_tools: newValue })}
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
                <TextField {...params} label="Disabled Tools" placeholder="Select tools to disable..." helperText="Tools to disable for this agent (all tools enabled by default)" />
              )}
            />

            {/* Preferred Name */}
            <TextField
              label="Preferred Name"
              value={formData.preferred_name}
              onChange={(e) => setFormData({ ...formData, preferred_name: e.target.value })}
              fullWidth
              helperText="How this agent should address you"
            />

            {/* Trigger Word */}
            <TextField
              label="Trigger Word"
              value={formData.trigger_word}
              onChange={(e) => setFormData({ ...formData, trigger_word: e.target.value })}
              fullWidth
              helperText="Say this word to activate voice interaction mode (e.g., agent's name)"
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
            disabled={!formData.name.trim() || !formData.model_name.trim()}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog
        open={editDialogOpen}
        onClose={() => setEditDialogOpen(false)}
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
                Edit Agent
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 520 }}>
                Refine identity, prompting, tools, memory, and media settings in one place.
              </Typography>
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ pt: 0.5 }}>
              {isAdministrator ? 'System agent' : 'Custom agent'}
            </Typography>
          </Box>
        </DialogTitle>
        <DialogContent sx={{ p: 3 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
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
                    {formData.name?.[0]?.toUpperCase() || 'A'}
                  </Avatar>
                  <Box>
                    <Typography variant="h6" sx={{ fontWeight: 600 }}>
                      {formData.name || 'Unnamed Agent'}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                      {isAdministrator ? 'Core routing agent with protected identity settings.' : 'A tuned persona for voice, memory, and multi-tool workflows.'}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                      {formData.model_name || 'No model selected'}
                      {formData.think ? ' • Extended thinking' : ''}
                      {formData.memory_enabled ? ' • Memory enabled' : ''}
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
                  {selectedAgent?.character_config && (
                    <Button
                      variant="outlined"
                      startIcon={isDetecting ? <CircularProgress size={16} /> : <AutoAwesomeIcon />}
                      onClick={async () => {
                        if (!selectedAgent) return;
                        setIsDetecting(true);
                        setAvatarCandidates([]);
                        try {
                          const candidates = await apiClient.getAvatarCandidates(selectedAgent.id);
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
                            if (!selectedAgent) return;
                            try {
                              await apiClient.setAgentAvatarFromUuid(selectedAgent.id, candidate.uuid);
                              setAvatarPreview(apiClient.getImageUrl(candidate.uuid));
                              setAvatarCandidates([]);
                              setSuccessMessage('Avatar updated!');
                              setTimeout(() => setSuccessMessage(''), 3000);
                              loadAgents();
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
              <Box sx={formSectionSx}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                  <BadgeIcon fontSize="small" color="primary" />
                  <Typography variant="h6">Identity</Typography>
                </Box>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <TextField
                    label="Agent Name"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    fullWidth
                    required
                    disabled={isAdministrator}
                    helperText={isAdministrator ? 'Administrator name cannot be changed' : 'Display name used across the app'}
                  />
                  <TextField
                    label="Preferred Name"
                    value={formData.preferred_name}
                    onChange={(e) => setFormData({ ...formData, preferred_name: e.target.value })}
                    fullWidth
                    helperText="How this agent should address you"
                  />
                  <TextField
                    label="Trigger Word"
                    value={formData.trigger_word}
                    onChange={(e) => setFormData({ ...formData, trigger_word: e.target.value })}
                    fullWidth
                    helperText="Voice activation phrase for this agent"
                  />
                </Box>
              </Box>
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
                    {(voiceFile || selectedAgent?.voice_reference) && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.25 }}>
                        {voiceFile ? voiceFile.name : `Current: ${selectedAgent?.voice_reference}`}
                      </Typography>
                    )}
                  </Box>
                  <Box sx={{ p: 2, borderRadius: 2, backgroundColor: 'background.default', border: '1px solid', borderColor: 'divider' }}>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      Character Animation
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, mb: 1.5 }}>
                      Manage pose assets and animation graph for this agent.
                    </Typography>
                    <Button
                      variant="outlined"
                      startIcon={<FaceIcon />}
                      onClick={() => {
                        if (selectedAgent) {
                          setCharacterConfigAgent(selectedAgent);
                          setCharacterConfigOpen(true);
                        }
                      }}
                      size="small"
                    >
                      Configure Character Animation
                      {selectedAgent?.character_config ? ' (Configured)' : ''}
                    </Button>
                  </Box>
                </Box>
              </Box>
            </Box>

            <Box sx={formSectionSx}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                <PsychologyIcon fontSize="small" color="primary" />
                <Typography variant="h6">Behavior</Typography>
              </Box>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
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
                        System Prompt
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Define persona, boundaries, tone, and workflow expectations.
                      </Typography>
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Typography variant="caption" color="text.secondary">
                        {(isAdministrator ? 'System agent for routing conversations' : formData.system_prompt).length} chars
                      </Typography>
                      <Button
                        size="small"
                        variant="text"
                        startIcon={isPromptEditorExpanded ? <CloseFullscreenIcon /> : <OpenInFullIcon />}
                        onClick={() => setIsPromptEditorExpanded((current) => !current)}
                        disabled={isAdministrator}
                      >
                        {isPromptEditorExpanded ? 'Compact' : 'Expand'}
                      </Button>
                    </Box>
                  </Box>
                  <TextField
                    label={isPromptEditorExpanded ? 'Prompt Workspace' : 'System Prompt'}
                    value={isAdministrator ? 'System agent for routing conversations' : formData.system_prompt}
                    onChange={(e) => setFormData({ ...formData, system_prompt: e.target.value })}
                    multiline
                    minRows={isPromptEditorExpanded ? 12 : 6}
                    maxRows={isPromptEditorExpanded ? 20 : 10}
                    fullWidth
                    disabled={isAdministrator}
                    helperText={isAdministrator ? 'Administrator uses built-in routing logic' : 'Write instructions in plain language. Include role, response style, constraints, and when to use tools.'}
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
                <ModelPicker
                  label="Model"
                  value={formData.model_name}
                  models={models}
                  onChange={(model_name) => setFormData({ ...formData, model_name })}
                  onRefresh={loadModels}
                  onSuccess={(message) => {
                    setSuccessMessage(message);
                    setTimeout(() => setSuccessMessage(''), 3000);
                  }}
                  onError={setError}
                  required
                />
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, p: 2, borderRadius: 2, backgroundColor: 'background.default', border: '1px solid', borderColor: 'divider' }}>
                  <Box>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      Extended Thinking
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Allow this agent to use longer reasoning traces when the backend supports it.
                    </Typography>
                  </Box>
                  <Switch checked={formData.think} onChange={(e) => setFormData({ ...formData, think: e.target.checked })} />
                </Box>
              </Box>
            </Box>

            <Box sx={formSectionSx}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                <ExtensionIcon fontSize="small" color="primary" />
                <Typography variant="h6">Tools & Memory</Typography>
              </Box>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Autocomplete
                  multiple
                  options={availableTools.map(t => t.function.name)}
                  value={formData.excluded_tools}
                  onChange={(_, newValue) => setFormData({ ...formData, excluded_tools: newValue })}
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
                              {tool.function.description.length > 80 ? tool.function.description.slice(0, 80) + '...' : tool.function.description}
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
                    <TextField {...params} label="Disabled Tools" placeholder="Select tools to disable..." helperText="All tools remain enabled by default. Select only the ones this agent should not use." />
                  )}
                />
                <Box sx={{ p: 2, borderRadius: 2, backgroundColor: 'background.default', border: '1px solid', borderColor: 'divider' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
                    <Box>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        Agent Memory
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Keep long-term notes that help this agent stay consistent over time.
                      </Typography>
                    </Box>
                    <Switch checked={formData.memory_enabled} onChange={(e) => setFormData({ ...formData, memory_enabled: e.target.checked })} />
                  </Box>
                  {formData.memory_enabled && (
                    <TextField
                      label="Memory"
                      value={formData.memory}
                      onChange={(e) => setFormData({ ...formData, memory: e.target.value })}
                      multiline
                      minRows={4}
                      maxRows={10}
                      fullWidth
                      placeholder="No memories yet. Memory is automatically built from conversations."
                      helperText="Auto-updated after conversations. You can also edit manually."
                      sx={{ mt: 2 }}
                    />
                  )}
                </Box>
              </Box>
            </Box>
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2, borderTop: '1px solid', borderColor: 'divider', justifyContent: 'space-between' }}>
          <Typography variant="caption" color="text.secondary" sx={{ mr: 2 }}>
            Changes apply immediately after saving.
          </Typography>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button onClick={() => setEditDialogOpen(false)}>Cancel</Button>
            <Button
              variant="contained"
              startIcon={<SaveIcon />}
              onClick={handleUpdateAgent}
              disabled={!formData.name.trim() || !formData.model_name.trim()}
            >
              Save Changes
            </Button>
          </Box>
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

      {/* Character Config Dialog */}
      {characterConfigAgent && (
        <CharacterConfigDialog
          open={characterConfigOpen}
          agent={characterConfigAgent}
          onClose={() => {
            setCharacterConfigOpen(false);
            setCharacterConfigAgent(null);
          }}
          onSaved={loadAgents}
        />
      )}
    </Box>
  );
};
