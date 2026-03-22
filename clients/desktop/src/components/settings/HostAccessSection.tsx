import React, { useState, useEffect } from 'react';
import {
  Box,
  Paper,
  Typography,
  IconButton,
  Alert,
  Button,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  FolderOpen as FolderOpenIcon,
} from '@mui/icons-material';
import { refreshClientMCPServers } from '../../services/mcpService';
import { useAgentStore } from '../../store/agentStore';

export const HostAccessSection: React.FC = () => {
  const agents = useAgentStore((s) => s.agents);
  const [selectedAgentId, setSelectedAgentId] = useState<number | null>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [newPath, setNewPath] = useState('');
  const [saving, setSaving] = useState(false);

  // Load paths when agent selection changes
  useEffect(() => {
    if (!selectedAgentId || !window.electron?.hostTools) return;
    window.electron.hostTools.getAllowedPaths(selectedAgentId).then(setPaths);
  }, [selectedAgentId]);

  // Auto-select first agent
  useEffect(() => {
    if (!selectedAgentId && agents.length > 0) {
      setSelectedAgentId(agents[0].id);
    }
  }, [agents, selectedAgentId]);

  const savePaths = async (newPaths: string[]) => {
    if (!selectedAgentId || !window.electron?.hostTools) return;
    setSaving(true);
    try {
      await window.electron.hostTools.setAllowedPaths(selectedAgentId, newPaths);
      setPaths(newPaths);
      // Refresh client tools to re-register with backend
      await refreshClientMCPServers();
    } finally {
      setSaving(false);
    }
  };

  const addPath = () => {
    const trimmed = newPath.trim();
    if (!trimmed || paths.includes(trimmed)) return;
    savePaths([...paths, trimmed]);
    setNewPath('');
  };

  const removePath = (index: number) => {
    savePaths(paths.filter((_, i) => i !== index));
  };

  return (
    <Box>
      <Typography variant="h5" gutterBottom fontWeight={600}>
        Host Access
      </Typography>

      <Box sx={{ maxWidth: 900, mx: 'auto' }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Configure which directories each agent can access on this machine.
          File tools (host_read, host_write, host_edit, host_search) auto-execute within allowed paths.
          Shell commands (host_bash) always require approval.
        </Typography>

        <FormControl fullWidth sx={{ mb: 3 }}>
          <InputLabel>Agent</InputLabel>
          <Select
            value={selectedAgentId || ''}
            label="Agent"
            onChange={(e) => setSelectedAgentId(e.target.value as number)}
          >
            {agents.map((agent) => (
              <MenuItem key={agent.id} value={agent.id}>
                {agent.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        {selectedAgentId && (
          <>
            <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
              Allowed Directories
            </Typography>

            {paths.length === 0 ? (
              <Alert severity="info" sx={{ mb: 2 }}>
                No allowed paths configured. Host tools will be unavailable for this agent.
              </Alert>
            ) : (
              <Box sx={{ mb: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
                {paths.map((p, i) => (
                  <Paper
                    key={i}
                    variant="outlined"
                    sx={{ p: 1.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <FolderOpenIcon fontSize="small" color="action" />
                      <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{p}</Typography>
                    </Box>
                    <IconButton size="small" onClick={() => removePath(i)} disabled={saving}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Paper>
                ))}
              </Box>
            )}

            <Box sx={{ display: 'flex', gap: 1 }}>
              <TextField
                size="small"
                fullWidth
                placeholder="Absolute path, e.g. D:\Projects or /home/user/code"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addPath()}
              />
              <Button
                variant="contained"
                size="small"
                onClick={addPath}
                disabled={saving || !newPath.trim()}
                startIcon={<AddIcon />}
              >
                Add
              </Button>
            </Box>
          </>
        )}
      </Box>
    </Box>
  );
};
