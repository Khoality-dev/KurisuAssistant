import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Box,
  Paper,
  Typography,
  TextField,
  Button,
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
  Select,
  MenuItem,
  FormControl,
  InputLabel,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  Save as SaveIcon,
  Refresh as RefreshIcon,
  Settings as SettingsIcon,
  FileDownload as ExportIcon,
  FileUpload as ImportIcon,
} from '@mui/icons-material';
import { motion, AnimatePresence } from 'framer-motion';
import { apiClient } from '../../api/client';
import { useAgentStore } from '../../store/agentStore';
import { storage } from '../../utils/storage';
import type { Agent, AgentCreate, AgentUpdate, Tool, Persona } from '../../api/types';
import { ModelPicker } from '../ModelPicker';
import { ToolGroupChecklist, buildToolGroups } from './ToolGroupChecklist';
import { AgentEditDialog } from './AgentEditDialog';

const MotionCard = motion(Card);

// Internal tools that shouldn't appear in the exclusion list
const INTERNAL_TOOLS = ['route_to_agent', 'route_to_user', 'play_music', 'music_control', 'get_music_queue'];

interface AgentFormData {
  name: string;
  system_prompt: string;
  model_name: string;
  think: boolean;
  excluded_tools: string[];
  memory: string;
  memory_enabled: boolean;
  persona_id: number | null;
}

export const AgentsSection: React.FC = () => {
  const { loadAgents: refreshAgentStore } = useAgentStore();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [models, setModels] = useState<Array<{ name: string; provider: string }>>([]);
  const [availableTools, setAvailableTools] = useState<Tool[]>([]);
  const [mcpServerMap, setMcpServerMap] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
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
    excluded_tools: [],
    memory: '',
    memory_enabled: true,
    persona_id: null,
  });
  const [personas, setPersonas] = useState<Persona[]>([]);

  const [isPromptEditorExpanded, setIsPromptEditorExpanded] = useState(false);

  const toolGroups = useMemo(() => buildToolGroups(availableTools, mcpServerMap), [availableTools, mcpServerMap]);

  useEffect(() => {
    loadAgents();
    loadModels();
    loadTools();
    loadPersonas();
  }, []);

  const loadPersonas = async () => {
    try {
      const data = await apiClient.listPersonas();
      setPersonas(data);
    } catch (err: any) {
      console.error('Failed to load personas:', err);
    }
  };

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
      // Build MCP server → tool name mapping for grouping
      const serverMap: Record<string, string[]> = {};
      if (data.mcp_servers) {
        for (const [serverName, tools] of Object.entries(data.mcp_servers)) {
          serverMap[serverName] = tools.map(t => t.function.name);
        }
      }
      setMcpServerMap(serverMap);
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
        persona_id: formData.persona_id || undefined,
      };

      const newAgent = await apiClient.createAgent(createData);

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
        provider_type: models.find(m => m.name === normalizedModelName)?.provider || 'ollama',
        think: formData.think !== selectedAgent.think ? formData.think : undefined,
        excluded_tools: toolsChanged ? formData.excluded_tools : undefined,
        memory: formData.memory !== (selectedAgent.memory || '') ? formData.memory : undefined,
        memory_enabled: formData.memory_enabled !== selectedAgent.memory_enabled ? formData.memory_enabled : undefined,
        persona_id: formData.persona_id !== selectedAgent.persona_id ? formData.persona_id : undefined,
      };

      // Only send fields that changed
      const hasChanges = Object.values(updateData).some(v => v !== undefined);
      if (hasChanges) {
        await apiClient.updateAgent(selectedAgent.id, updateData);
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

  const handleExportAgent = async (agent: Agent) => {
    try {
      const blob = await apiClient.exportAgent(agent.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${agent.name.replace(/\s+/g, '_')}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setSuccessMessage(`Agent "${agent.name}" exported!`);
      setTimeout(() => setSuccessMessage(''), 3000);
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to export agent');
    }
  };

  const handleImportAgent = async (file: File) => {
    try {
      const agent = await apiClient.importAgent(file);
      setSuccessMessage(`Agent "${agent.name}" imported!`);
      setTimeout(() => setSuccessMessage(''), 3000);
      loadAgents();
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to import agent');
    }
  };

  const importInputRef = useRef<HTMLInputElement>(null);

  const resetForm = () => {
    setFormData({
      name: '',
      system_prompt: '',
      model_name: '',
      think: false,
      excluded_tools: [],
      memory: '',
      memory_enabled: true,
      persona_id: null,
    });
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
      persona_id: agent.persona_id || null,
    });
    setIsPromptEditorExpanded(false);
    setEditDialogOpen(true);
    loadTools();
  };

  const openDeleteDialog = (agent: Agent) => {
    setSelectedAgent(agent);
    setDeleteDialogOpen(true);
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
            variant="outlined"
            startIcon={<ImportIcon />}
            onClick={() => importInputRef.current?.click()}
          >
            Import
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept=".zip,.json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImportAgent(file);
              e.target.value = '';
            }}
          />
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
            Create your first agent to get started. Agents define roles, models, and tool access.
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
                loadTools();
              }}
            >
              Create Agent
            </Button>
          </Box>
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
                    border: agent.is_system ? '2px solid' : '1px solid',
                    borderColor: agent.is_system ? 'secondary.main' : 'divider',
                    opacity: agent.enabled ? 1 : 0.5,
                    cursor: 'pointer',
                    '&:hover': {
                      boxShadow: 3,
                      transform: 'translateY(-2px)',
                    },
                    transition: 'box-shadow 0.2s, transform 0.2s, opacity 0.2s',
                  }}
                >
                  {agent.is_system && (
                    <Chip
                      label="Built-in"
                      color="secondary"
                      size="small"
                      icon={<SettingsIcon />}
                      sx={{ position: 'absolute', top: 12, right: 12 }}
                    />
                  )}
                  <CardContent sx={{ pt: 3 }}>
                    <Typography variant="h6" gutterBottom>
                      {agent.name}
                    </Typography>
                    {agent.persona?.name && (
                      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                        Persona: {agent.persona.name}
                      </Typography>
                    )}
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
                    <Box sx={{ mt: 2, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                      {agent.model_name && (
                        <Chip label={agent.model_name} size="small" variant="outlined" />
                      )}
                      {agent.provider_type && (
                        <Chip label={agent.provider_type} size="small" variant="outlined" color="info" />
                      )}
                    </Box>
                  </CardContent>
                  <CardActions sx={{ justifyContent: 'space-between', px: 2, pb: 2 }}>
                    <Switch
                      size="small"
                      checked={agent.enabled}
                      onClick={(e) => e.stopPropagation()}
                      onChange={async (e) => {
                        e.stopPropagation();
                        try {
                          await apiClient.toggleAgentEnabled(agent.id, !agent.enabled);
                          loadAgents();
                        } catch (err: any) {
                          setError(err.response?.data?.detail || err.message);
                        }
                      }}
                    />
                    <Box>
                      <Tooltip title="Export">
                        <IconButton
                          onClick={(e) => {
                            e.stopPropagation();
                            handleExportAgent(agent);
                          }}
                        >
                          <ExportIcon />
                        </IconButton>
                      </Tooltip>
                      {!agent.is_system && (
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
                    </Box>
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
            {/* Name */}
            <TextField
              label="Agent Name"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              fullWidth
              required
              helperText="A unique name for this agent (e.g., 'Kurisu')"
            />

            {/* Persona */}
            <FormControl fullWidth>
              <InputLabel>Persona</InputLabel>
              <Select
                value={formData.persona_id ?? ''}
                label="Persona"
                onChange={(e) => setFormData({ ...formData, persona_id: e.target.value === '' ? null : Number(e.target.value) })}
              >
                <MenuItem value="">None</MenuItem>
                {personas.map((p) => (
                  <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>
                ))}
              </Select>
            </FormControl>

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
            <Box>
              <Typography variant="body2" sx={{ mb: 1, fontWeight: 500 }}>Enabled Tools</Typography>
              <ToolGroupChecklist
                groups={toolGroups}
                excludedTools={formData.excluded_tools}
                onChange={(excluded) => setFormData({ ...formData, excluded_tools: excluded })}
              />
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                All tools enabled by default. Uncheck to disable for this agent.
              </Typography>
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
      <AgentEditDialog
        open={editDialogOpen}
        onClose={() => setEditDialogOpen(false)}
        formData={formData}
        setFormData={setFormData}
        isAdministrator={isAdministrator}
        isPromptEditorExpanded={isPromptEditorExpanded}
        setIsPromptEditorExpanded={setIsPromptEditorExpanded}
        models={models}
        personas={personas}
        toolGroups={toolGroups}
        onSave={handleUpdateAgent}
        onRefreshModels={loadModels}
        onSuccess={(message) => {
          setSuccessMessage(message);
          setTimeout(() => setSuccessMessage(''), 3000);
        }}
        onError={setError}
      />

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
