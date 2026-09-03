import React, { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Paper,
  Typography,
  IconButton,
  Alert,
  Button,
  TextField,
  Chip,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  FolderOpen as FolderOpenIcon,
  Build as BuildIcon,
  Schedule as ScheduleIcon,
} from '@mui/icons-material';
import { refreshClientMCPServers } from '../../services/mcpService';

export const HostAccessSection: React.FC = () => {
  const [paths, setPaths] = useState<string[]>([]);
  const [toolPolicies, setToolPolicies] = useState<Record<string, 'auto' | 'deny'>>({});
  const [sessionApprovals, setSessionApprovals] = useState<string[]>([]);
  const [newPath, setNewPath] = useState('');
  const [saving, setSaving] = useState(false);

  const loadRules = useCallback(async () => {
    if (!window.electron?.hostTools) return;
    const [p, tp, sa] = await Promise.all([
      window.electron.hostTools.getAllowedPaths(),
      window.electron.hostTools.getToolPolicies(),
      window.electron.hostTools.getSessionApprovals(),
    ]);
    setPaths(p);
    setToolPolicies(tp);
    setSessionApprovals(sa);
  }, []);

  useEffect(() => { loadRules(); }, [loadRules]);

  const savePaths = async (newPaths: string[]) => {
    if (!window.electron?.hostTools) return;
    setSaving(true);
    try {
      await window.electron.hostTools.setAllowedPaths(newPaths);
      setPaths(newPaths);
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

  const removePolicy = async (toolName: string) => {
    if (!window.electron?.hostTools) return;
    await window.electron.hostTools.removeToolPolicy(toolName);
    const { [toolName]: _, ...rest } = toolPolicies;
    setToolPolicies(rest);
  };

  const clearSession = async () => {
    if (!window.electron?.hostTools) return;
    await window.electron.hostTools.clearSessionApprovals();
    setSessionApprovals([]);
  };

  const policyEntries = Object.entries(toolPolicies);
  const hasAnyRules = paths.length > 0 || policyEntries.length > 0 || sessionApprovals.length > 0;

  return (
    <Box>
      <Typography variant="h5" gutterBottom fontWeight={600}>
        Host Access
      </Typography>

      <Box sx={{ maxWidth: 900, mx: 'auto' }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Rules that control how host tools run. Paths and tool policies are persisted;
          session approvals clear on restart. Tools outside these rules prompt for approval.
        </Typography>

        {!hasAnyRules && (
          <Alert severity="info" sx={{ mb: 3 }}>
            No rules configured. All host tool calls will prompt for approval.
          </Alert>
        )}

        {/* Allowed Directories */}
        <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 1 }}>
          <FolderOpenIcon fontSize="small" />
          Allowed Directories
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ mb: 1.5, display: 'block' }}>
          File tools targeting these directories auto-execute without prompting.
        </Typography>

        {paths.length > 0 && (
          <Box sx={{ mb: 1.5, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
            {paths.map((p, i) => (
              <Paper
                key={i}
                variant="outlined"
                sx={{ px: 1.5, py: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
              >
                <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{p}</Typography>
                <IconButton size="small" onClick={() => removePath(i)} disabled={saving}>
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Paper>
            ))}
          </Box>
        )}

        <Box sx={{ display: 'flex', gap: 1, mb: 4 }}>
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

        {/* Tool Policies */}
        {policyEntries.length > 0 && (
          <>
            <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 1 }}>
              <BuildIcon fontSize="small" />
              Tool Policies
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ mb: 1.5, display: 'block' }}>
              Persistent per-tool rules. Remove to start prompting again.
            </Typography>

            <Box sx={{ mb: 4, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
              {policyEntries.map(([tool, policy]) => (
                <Paper
                  key={tool}
                  variant="outlined"
                  sx={{ px: 1.5, py: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{tool}</Typography>
                    <Chip
                      label={policy === 'auto' ? 'Always Approve' : 'Always Deny'}
                      size="small"
                      color={policy === 'auto' ? 'success' : 'error'}
                      variant="outlined"
                    />
                  </Box>
                  <IconButton size="small" onClick={() => removePolicy(tool)}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Paper>
              ))}
            </Box>
          </>
        )}

        {/* Session Approvals */}
        {sessionApprovals.length > 0 && (
          <>
            <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 1 }}>
              <ScheduleIcon fontSize="small" />
              Session Approvals
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ mb: 1.5, display: 'block' }}>
              Tools approved for this session. Cleared on app restart.
            </Typography>

            <Box sx={{ mb: 2, display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {sessionApprovals.map((tool) => (
                <Chip
                  key={tool}
                  label={tool}
                  size="small"
                  variant="outlined"
                  sx={{ fontFamily: 'monospace' }}
                />
              ))}
            </Box>
            <Button size="small" variant="outlined" color="warning" onClick={clearSession}>
              Clear Session Approvals
            </Button>
          </>
        )}
      </Box>
    </Box>
  );
};
