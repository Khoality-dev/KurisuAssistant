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
  Grid,
  Tooltip,
  FormControlLabel,
  Switch,
  Avatar,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  Save as SaveIcon,
  Refresh as RefreshIcon,
  FileDownload as ExportIcon,
  FileUpload as ImportIcon,
  SmartToy as AgentIcon,
} from '@mui/icons-material';
import { motion, AnimatePresence } from 'framer-motion';
import { apiClient } from '../../api/client';
import { useAgentStore } from '../../store/agentStore';
import { storage } from '../../utils/storage';
import type { Agent, AgentCreate, AgentUpdate, Tool } from '../../api/types';
import { ModelPicker } from '../ModelPicker';
import { ToolGroupChecklist, buildToolGroups } from './ToolGroupChecklist';
import { AgentEditDialog } from './AgentEditDialog';

const MotionCard = motion(Card);

// Internal tools that shouldn't appear in the exclusion list
const INTERNAL_TOOLS = ['play_music', 'music_control', 'get_music_queue'];

interface AgentFormData {
  name: string;
  description: string;
  system_prompt: string;
  model_name: string;
  think: boolean;
  available_tools: string[] | null;
  memory: string;
  memory_enabled: boolean;
  use_deferred_tools: boolean;
  agent_type: 'main' | 'sub';
  // Personality fields — MainAgent only
  voice_reference: string | null;
  avatar_uuid: string | null;
  preferred_name: string | null;
  trigger_word: string | null;
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
    description: '',
    system_prompt: '',
    model_name: '',
    think: false,
    available_tools: null,
    memory: '',
    memory_enabled: true,
    use_deferred_tools: false,
    agent_type: 'main',
    voice_reference: null,
    avatar_uuid: null,
    preferred_name: null,
    trigger_word: null,
  });

  const toolGroups = useMemo(() => buildToolGroups(availableTools, mcpServerMap), [availableTools, mcpServerMap]);

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
      const isMain = formData.agent_type === 'main';
      const createData: AgentCreate = {
        name: formData.name,
        description: formData.description || undefined,
        system_prompt: formData.system_prompt || undefined,
        model_name: modelName,
        provider_type: provider,
        think: formData.think,
        available_tools: formData.available_tools ?? undefined,
        use_deferred_tools: formData.use_deferred_tools || undefined,
        agent_type: formData.agent_type,
        // Identity fields only apply to main agents
        voice_reference: isMain ? (formData.voice_reference || undefined) : undefined,
        avatar_uuid: isMain ? (formData.avatar_uuid || undefined) : undefined,
        preferred_name: isMain ? (formData.preferred_name || undefined) : undefined,
        trigger_word: isMain ? (formData.trigger_word || undefined) : undefined,
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
      const toolsChanged = JSON.stringify(formData.available_tools) !== JSON.stringify(selectedAgent.available_tools ?? null);
      const normalizedModelName = formData.model_name.trim();
      const updateData: AgentUpdate = {
        name: formData.name !== selectedAgent.name ? formData.name : undefined,
        description: formData.description !== selectedAgent.description ? formData.description : undefined,
        system_prompt: formData.system_prompt !== selectedAgent.system_prompt ? formData.system_prompt : undefined,
        model_name: normalizedModelName !== (selectedAgent.model_name || '') ? normalizedModelName : undefined,
        provider_type: models.find(m => m.name === normalizedModelName)?.provider || 'ollama',
        think: formData.think !== selectedAgent.think ? formData.think : undefined,
        available_tools: toolsChanged ? (formData.available_tools ?? undefined) : undefined,
        memory: formData.memory !== (selectedAgent.memory || '') ? formData.memory : undefined,
        memory_enabled: formData.memory_enabled !== selectedAgent.memory_enabled ? formData.memory_enabled : undefined,
        use_deferred_tools: formData.use_deferred_tools !== selectedAgent.use_deferred_tools ? formData.use_deferred_tools : undefined,
        agent_type: formData.agent_type !== selectedAgent.agent_type ? formData.agent_type : undefined,
        voice_reference: formData.voice_reference !== selectedAgent.voice_reference ? formData.voice_reference : undefined,
        avatar_uuid: formData.avatar_uuid !== selectedAgent.avatar_uuid ? formData.avatar_uuid : undefined,
        preferred_name: formData.preferred_name !== selectedAgent.preferred_name ? formData.preferred_name : undefined,
        trigger_word: formData.trigger_word !== selectedAgent.trigger_word ? formData.trigger_word : undefined,
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

  const resetForm = (agentType: 'main' | 'sub' = 'main') => {
    setFormData({
      name: '',
      description: '',
      system_prompt: '',
      model_name: '',
      think: false,
      available_tools: null,
      memory: '',
      memory_enabled: true,
      use_deferred_tools: false,
      agent_type: agentType,
      voice_reference: null,
      avatar_uuid: null,
      preferred_name: null,
      trigger_word: null,
    });
    setSelectedAgent(null);
  };

  const openEditDialog = (agent: Agent) => {
    setSelectedAgent(agent);
    setFormData({
      name: agent.name,
      description: agent.description || '',
      system_prompt: agent.system_prompt || '',
      model_name: agent.model_name || '',
      think: agent.think,
      available_tools: agent.available_tools ?? null,
      memory: agent.memory || '',
      memory_enabled: agent.memory_enabled,
      use_deferred_tools: agent.use_deferred_tools ?? false,
      agent_type: (agent.agent_type as 'main' | 'sub') || 'main',
      voice_reference: agent.voice_reference || null,
      avatar_uuid: agent.avatar_uuid || null,
      preferred_name: agent.preferred_name || null,
      trigger_word: (agent as any).trigger_word || null,
    });
    setEditDialogOpen(true);
    loadTools();
  };

  const openDeleteDialog = (agent: Agent) => {
    setSelectedAgent(agent);
    setDeleteDialogOpen(true);
  };

  const isSystemAgent = selectedAgent?.is_system ?? false;

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
            variant="outlined"
            startIcon={<AddIcon />}
            onClick={() => {
              resetForm('sub');
              setCreateDialogOpen(true);
              loadTools();
            }}
          >
            New Sub-Agent
          </Button>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => {
              resetForm('main');
              setCreateDialogOpen(true);
              loadTools();
            }}
          >
            New Main Agent
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
            Create your first agent to get started. Main agents have identity and talk to the user;
            sub-agents are task-only workers that a main agent can call.
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
                resetForm('main');
                setCreateDialogOpen(true);
                loadTools();
              }}
            >
              Create Main Agent
            </Button>
          </Box>
        </Paper>
      ) : (() => {
        const renderAgentCard = (agent: Agent) => (
          <Grid item xs={12} sm={6} md={4} key={agent.id}>
            <MotionCard
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.3 }}
              onClick={() => openEditDialog(agent)}
              sx={{
                position: 'relative',
                border: '1px solid',
                borderColor: 'divider',
                opacity: agent.enabled ? 1 : 0.5,
                cursor: 'pointer',
                '&:hover': {
                  boxShadow: 3,
                  transform: 'translateY(-2px)',
                },
                transition: 'box-shadow 0.2s, transform 0.2s, opacity 0.2s',
              }}
            >
              <CardContent>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1, flexWrap: 'wrap' }}>
                  <Avatar
                    src={agent.avatar_uuid ? apiClient.getImageUrl(agent.avatar_uuid) : undefined}
                    sx={{
                      width: 44,
                      height: 44,
                      bgcolor: (t) => (t.palette.mode === 'light' ? '#F3F4F6' : '#262626'),
                      flexShrink: 0,
                    }}
                  >
                    {!agent.avatar_uuid && (
                      <AgentIcon sx={{ fontSize: 22, color: 'text.secondary' }} />
                    )}
                  </Avatar>
                  {/* Name: wraps to a new line if the card is too narrow for
                      avatar + name on one row. wordBreak prevents long names
                      from staying invisible behind overflow:hidden when the
                      card collapses to ~120px (Grid md=4 in a narrow panel). */}
                  <Typography variant="h6" sx={{ minWidth: 0, flex: '1 1 auto', wordBreak: 'break-word' }}>
                    {agent.name}
                  </Typography>
                </Box>
                {agent.description && (
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                    {agent.description}
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
                {(agent.model_name || agent.trigger_word || agent.is_system) && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ mt: 1.5, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {[
                      agent.model_name,
                      agent.trigger_word ? `"${agent.trigger_word}"` : null,
                      agent.is_system ? 'System' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Typography>
                )}
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
        );

        const mainAgents = agents.filter(a => a.agent_type !== 'sub');
        const subAgents = agents.filter(a => a.agent_type === 'sub');

        return (
          <Box sx={{ maxWidth: 1200, mx: 'auto' }}>
            <Box sx={{ mb: 2, display: 'flex', alignItems: 'baseline', gap: 1.5 }}>
              <Typography variant="h6">Main Agents</Typography>
              <Typography variant="caption" color="text.secondary">
                {mainAgents.length} · has personality and talks to you
              </Typography>
            </Box>
            {mainAgents.length === 0 ? (
              <Paper sx={{ p: 3, mb: 4, textAlign: 'center', color: 'text.secondary' }}>
                No main agents yet. Click "New Main Agent" to create one.
              </Paper>
            ) : (
              <Grid container spacing={3} sx={{ mb: 4 }}>
                <AnimatePresence>{mainAgents.map(renderAgentCard)}</AnimatePresence>
              </Grid>
            )}

            <Box sx={{ mb: 2, display: 'flex', alignItems: 'baseline', gap: 1.5 }}>
              <Typography variant="h6">Sub-Agents</Typography>
              <Typography variant="caption" color="text.secondary">
                {subAgents.length} · task-only workers callable by main agents
              </Typography>
            </Box>
            {subAgents.length === 0 ? (
              <Paper sx={{ p: 3, textAlign: 'center', color: 'text.secondary' }}>
                No sub-agents yet. Click "New Sub-Agent" to add a specialized worker.
              </Paper>
            ) : (
              <Grid container spacing={3}>
                <AnimatePresence>{subAgents.map(renderAgentCard)}</AnimatePresence>
              </Grid>
            )}
          </Box>
        );
      })()}

      {/* Create Dialog */}
      <Dialog open={createDialogOpen} onClose={() => setCreateDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>
          Create {formData.agent_type === 'sub' ? 'Sub-Agent' : 'Main Agent'}
        </DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, mt: 1 }}>
            {/* Name */}
            <TextField
              label="Agent Name"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              fullWidth
              required
              helperText={
                formData.agent_type === 'sub'
                  ? "A skill name (e.g., 'Researcher')"
                  : "A unique character name (e.g., 'Kurisu')"
              }
            />

            {/* Trigger word — main agents only */}
            {formData.agent_type === 'main' && (
              <TextField
                label="Trigger Word (optional)"
                value={formData.trigger_word || ''}
                onChange={(e) => setFormData({ ...formData, trigger_word: e.target.value || null })}
                fullWidth
                helperText="If a new conversation's first message contains this word, this agent is picked. Otherwise a main agent is chosen at random."
              />
            )}

            {/* System Prompt */}
            <TextField
              label={formData.agent_type === 'sub' ? 'Task Instructions' : 'System Prompt'}
              value={formData.system_prompt}
              onChange={(e) => setFormData({ ...formData, system_prompt: e.target.value })}
              multiline
              rows={4}
              fullWidth
              helperText={
                formData.agent_type === 'sub'
                  ? "What this sub-agent should do when called. No personality — just the task."
                  : "Define the agent's personality and behavior"
              }
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
                enabledTools={formData.available_tools}
                onChange={(enabled) => setFormData({ ...formData, available_tools: enabled })}
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
        isSystemAgent={isSystemAgent}
        models={models}
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
