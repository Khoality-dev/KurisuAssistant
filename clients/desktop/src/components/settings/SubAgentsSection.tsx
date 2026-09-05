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
  Add as AddIcon,
  Engineering as SubAgentIcon,
  FileUpload as ImportIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import { AnimatePresence } from 'framer-motion';
import { apiClient } from '../../api/client';
import type { SubAgent } from '../../api/types';
import { ResourceCard } from './ResourceCard';
import { SubAgentEditDialog } from './SubAgentEditDialog';
import { useAvailableTools } from './useAvailableTools';

/**
 * Sub-agents: task-only workers the assistant delegates to mid-answer. Each has
 * its own model and tools and no identity at all, so nothing here has a voice,
 * an avatar or a memory.
 */
export const SubAgentsSection: React.FC = () => {
  const [subAgents, setSubAgents] = useState<SubAgent[]>([]);
  const [models, setModels] = useState<Array<{ name: string; provider: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SubAgent | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SubAgent | null>(null);

  const importInputRef = useRef<HTMLInputElement>(null);
  const { toolGroups } = useAvailableTools(setError);

  const flash = (message: string) => {
    setSuccessMessage(message);
    setTimeout(() => setSuccessMessage(''), 3000);
  };

  const loadModels = async () => {
    try {
      setModels(await apiClient.getModels());
    } catch (err: any) {
      console.error('Failed to load models:', err);
      setError('Failed to load the model list');
    }
  };

  const loadSubAgents = async () => {
    try {
      setLoading(true);
      setSubAgents(await apiClient.listSubAgents());
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to load sub-agents');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSubAgents();
    void loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggleEnabled = async (subAgent: SubAgent, enabled: boolean) => {
    try {
      await apiClient.toggleSubAgentEnabled(subAgent.id, enabled);
      await loadSubAgents();
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to change the sub-agent');
    }
  };

  const handleExport = async (subAgent: SubAgent) => {
    try {
      const blob = await apiClient.exportSubAgent(subAgent.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${subAgent.name.replace(/\s+/g, '_')}.json`;
      a.click();
      URL.revokeObjectURL(url);
      flash(`Sub-agent "${subAgent.name}" exported.`);
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to export the sub-agent');
    }
  };

  const handleImport = async (file: File) => {
    try {
      const subAgent = await apiClient.importSubAgent(file);
      flash(`Sub-agent "${subAgent.name}" imported.`);
      await loadSubAgents();
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to import the sub-agent');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await apiClient.deleteSubAgent(deleteTarget.id);
      flash(`Sub-agent "${deleteTarget.name}" deleted.`);
      setDeleteTarget(null);
      await loadSubAgents();
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to delete the sub-agent');
      setDeleteTarget(null);
    }
  };

  const openCreate = () => {
    setEditing(null);
    setEditDialogOpen(true);
  };

  const openEdit = (subAgent: SubAgent) => {
    setEditing(subAgent);
    setEditDialogOpen(true);
  };

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 0.5, fontWeight: 600 }}>Sub-Agents</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Task-only workers your assistant can hand a job to mid-answer. Each runs its own model and
        tools; none of them has a face, a voice or a memory, and none is ever shown as the speaker.
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
        <Typography variant="h6">{subAgents.length} worker{subAgents.length === 1 ? '' : 's'}</Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Tooltip title="Reload sub-agents">
            <IconButton onClick={loadSubAgents} disabled={loading}>
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
            New Sub-Agent
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
        <Typography sx={{ textAlign: 'center', mt: 4 }}>Loading sub-agents…</Typography>
      ) : subAgents.length === 0 ? (
        <Paper sx={{ p: 4, textAlign: 'center', maxWidth: 600, mx: 'auto' }}>
          <Typography variant="h6" gutterBottom>No sub-agents yet</Typography>
          <Typography color="text.secondary" sx={{ mb: 3 }}>
            Add one to give your assistant a specialist to delegate to — a researcher, a reviewer,
            anything with its own instructions and tools.
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, justifyContent: 'center' }}>
            <Button variant="outlined" startIcon={<ImportIcon />} onClick={() => importInputRef.current?.click()}>
              Import
            </Button>
            <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
              New Sub-Agent
            </Button>
          </Box>
        </Paper>
      ) : (
        <Box sx={{ maxWidth: 1200, mx: 'auto' }}>
          <Grid container spacing={3}>
            <AnimatePresence>
              {subAgents.map((subAgent) => (
                <Grid item xs={12} sm={6} md={4} key={subAgent.id}>
                  <ResourceCard
                    avatar={
                      <Avatar
                        sx={{
                          width: 44,
                          height: 44,
                          bgcolor: (t) => (t.palette.mode === 'light' ? '#F3F4F6' : '#262626'),
                          flexShrink: 0,
                        }}
                      >
                        <SubAgentIcon sx={{ fontSize: 22, color: 'text.secondary' }} />
                      </Avatar>
                    }
                    title={subAgent.name}
                    description={subAgent.description || undefined}
                    body={subAgent.system_prompt || 'No task instructions set'}
                    meta={[
                      subAgent.model_name || "assistant's model",
                      subAgent.available_tools === null ? 'all tools' : `${subAgent.available_tools.length} tools`,
                    ]}
                    enabled={subAgent.enabled}
                    onToggleEnabled={(enabled) => void handleToggleEnabled(subAgent, enabled)}
                    onExport={() => void handleExport(subAgent)}
                    onDelete={() => setDeleteTarget(subAgent)}
                    onClick={() => openEdit(subAgent)}
                  />
                </Grid>
              ))}
            </AnimatePresence>
          </Grid>
        </Box>
      )}

      <SubAgentEditDialog
        open={editDialogOpen}
        subAgent={editing}
        models={models}
        toolGroups={toolGroups}
        onClose={() => {
          setEditDialogOpen(false);
          void loadSubAgents();
        }}
        onRefreshModels={loadModels}
        onSaved={flash}
        onSuccess={flash}
        onError={setError}
      />

      <Dialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)}>
        <DialogTitle>Delete sub-agent</DialogTitle>
        <DialogContent>
          <Typography>
            Delete "{deleteTarget?.name}"? This cannot be undone. Nothing else points at a
            sub-agent, so there is nothing to repair afterwards.
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
