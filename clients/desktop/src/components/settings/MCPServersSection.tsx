import React, { useState, useEffect, useCallback, useRef } from 'react';
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
  Chip,
  Button,
  CircularProgress,
  TextField,
  Switch,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
} from '@mui/material';
import {
  Refresh as RefreshIcon,
  Dns as DnsIcon,
  CheckCircle as CheckCircleIcon,
  Cancel as CancelIcon,
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  PlayArrow as TestIcon,
  Computer as ComputerIcon,
  Cloud as CloudIcon,
} from '@mui/icons-material';
import { motion, AnimatePresence } from 'framer-motion';
import { apiClient } from '../../api/client';
import type { MCPServer, MCPServerTestResult } from '../../api/types';
import { refreshClientMCPServers, getClientTools } from '../../services/mcpService';

const MotionCard = motion(Card);

interface LocalServer {
  id: string;
  name: string;
  type: 'sse' | 'stdio';
  // SSE servers
  healthUrl?: string;
  mcpUrl?: string;
  // Stdio servers (auto-managed by the app)
  mcpName?: string; // Name in the MCP server map
}

const LOCAL_SERVERS: LocalServer[] = [
  { id: 'maestro', name: 'Maestro', type: 'sse', healthUrl: 'http://127.0.0.1:29170/health', mcpUrl: 'http://127.0.0.1:29170/sse' },
  { id: 'chronicle', name: 'Chronicle', type: 'sse', healthUrl: 'http://127.0.0.1:29172/health', mcpUrl: 'http://127.0.0.1:29172/sse' },
  { id: 'playwright', name: 'Playwright', type: 'stdio', mcpName: 'Playwright' },
];

const LOCAL_SERVER_POLL_INTERVAL = 5000;

export const MCPServersSection: React.FC = () => {
  const [mcpServers, setMcpServers] = useState<MCPServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // MCP Server editor state
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<MCPServer | null>(null);
  const [serverName, setServerName] = useState('');
  const [serverTransportType, setServerTransportType] = useState<'sse' | 'stdio'>('sse');
  const [serverUrl, setServerUrl] = useState('');
  const [serverCommand, setServerCommand] = useState('');
  const [serverArgs, setServerArgs] = useState('');
  const [serverEnv, setServerEnv] = useState('');
  const [serverLocation, setServerLocation] = useState<'server' | 'client'>('server');
  const [serverSaving, setServerSaving] = useState(false);
  const [testingServerId, setTestingServerId] = useState<number | null>(null);
  const [testResults, setTestResults] = useState<Record<number, MCPServerTestResult>>({});

  // Local service detection state
  const [detectedServers, setDetectedServices] = useState<Record<string, { running: boolean; version?: string }>>({});
  const mcpAutoRegistered = useRef<Set<string>>(new Set());

  const registerLocalServer = useCallback(async (svc: LocalServer): Promise<boolean> => {
    // Local companion servers are started directly via Electron IPC — not saved to backend DB
    try {
      if (svc.mcpUrl && window.electron?.mcp?.startServer) {
        const result = await window.electron.mcp.startServer({
          name: svc.name,
          transport_type: 'sse',
          url: svc.mcpUrl,
        });
        if (!result.ok) {
          console.warn(`[LocalServers] Failed to start ${svc.name}:`, result.error);
          return false;
        }
      }
      mcpAutoRegistered.current.add(svc.id);
      await refreshClientMCPServers();
      return true;
    } catch (err) {
      console.error(`[LocalServers] Failed to start ${svc.name}:`, err);
      return false;
    }
  }, []);

  const checkLocalServers = useCallback(async () => {
    for (const svc of LOCAL_SERVERS) {
      if (svc.type === 'sse' && svc.healthUrl) {
        // SSE servers: poll health endpoint
        if (!window.electron?.extensions) continue;
        const data = await window.electron.extensions.checkHealth(svc.healthUrl);
        const running = !!(data && data.status === 'ok');
        setDetectedServices((prev) => ({
          ...prev,
          [svc.id]: { running, version: running ? data?.version : undefined },
        }));
        if (running && !mcpAutoRegistered.current.has(svc.id)) {
          await registerLocalServer(svc);
        }
      } else if (svc.type === 'stdio' && svc.mcpName) {
        // Stdio servers: check if running by listing tools
        let running = false;
        if (window.electron?.mcp) {
          try {
            const grouped = await window.electron.mcp.listToolsByServer();
            running = svc.mcpName in grouped;
          } catch {}
        }
        setDetectedServices((prev) => ({
          ...prev,
          [svc.id]: { running },
        }));
      }
    }
  }, [registerLocalServer]);

  const reconnectLocalServer = useCallback(async (svc: LocalServer) => {
    console.log(`[LocalServers] Reconnecting ${svc.name}...`);
    mcpAutoRegistered.current.delete(svc.id);
    setDetectedServices((prev) => ({ ...prev, [svc.id]: { running: false } }));

    if (svc.type === 'stdio' && svc.mcpName && window.electron?.mcp?.startServer) {
      // Restart stdio server
      const result = await window.electron.mcp.startServer(
        { name: svc.mcpName, transport_type: 'stdio', command: 'npx', args: ['@playwright/mcp'] },
      );
      setDetectedServices((prev) => ({ ...prev, [svc.id]: { running: result.ok } }));
      if (result.ok) await refreshClientMCPServers();
      return;
    }

    // SSE servers: health check + register
    if (!window.electron?.extensions || !svc.healthUrl) return;
    const data = await window.electron.extensions.checkHealth(svc.healthUrl);
    const running = !!(data && data.status === 'ok');
    console.log(`[LocalServers] ${svc.name} health check: ${running ? 'OK' : 'FAILED'}`, data);
    setDetectedServices((prev) => ({
      ...prev,
      [svc.id]: { running, version: running ? data?.version : undefined },
    }));
    if (running) {
      await registerLocalServer(svc);
    }
  }, [registerLocalServer]);

  useEffect(() => {
    checkLocalServers();
    const interval = setInterval(checkLocalServers, LOCAL_SERVER_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [checkLocalServers]);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const serversRes = await apiClient.listMCPServers();
      setMcpServers(serversRes);
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to load MCP servers');
    } finally {
      setLoading(false);
    }
  };

  // MCP Server handlers

  const handleNewServer = () => {
    setEditingServer(null);
    setServerName('');
    setServerTransportType('sse');
    setServerUrl('');
    setServerCommand('');
    setServerArgs('');
    setServerEnv('');
    setServerLocation('server');
    setMcpDialogOpen(true);
  };

  const handleEditServer = (server: MCPServer) => {
    setEditingServer(server);
    setServerName(server.name);
    setServerTransportType(server.transport_type);
    setServerUrl(server.url || '');
    setServerCommand(server.command || '');
    setServerArgs(server.args ? server.args.join('\n') : '');
    setServerEnv(
      server.env
        ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join('\n')
        : ''
    );
    setServerLocation(server.location || 'server');
    setMcpDialogOpen(true);
  };

  const handleSaveServer = async () => {
    if (!serverName.trim()) return;
    setServerSaving(true);
    try {
      const args = serverArgs.trim() ? serverArgs.trim().split('\n').map(s => s.trim()).filter(Boolean) : undefined;
      const env = serverEnv.trim()
        ? Object.fromEntries(
            serverEnv.trim().split('\n').map(line => {
              const idx = line.indexOf('=');
              return idx > 0 ? [line.slice(0, idx).trim(), line.slice(idx + 1).trim()] : null;
            }).filter((entry): entry is [string, string] => entry !== null)
          )
        : undefined;

      if (editingServer) {
        await apiClient.updateMCPServer(editingServer.id, {
          name: serverName,
          transport_type: serverTransportType,
          url: serverTransportType === 'sse' ? serverUrl : undefined,
          command: serverTransportType === 'stdio' ? serverCommand : undefined,
          args: serverTransportType === 'stdio' ? args : undefined,
          env,
          location: serverLocation,
        });
      } else {
        await apiClient.createMCPServer({
          name: serverName,
          transport_type: serverTransportType,
          url: serverTransportType === 'sse' ? serverUrl : undefined,
          command: serverTransportType === 'stdio' ? serverCommand : undefined,
          args: serverTransportType === 'stdio' ? args : undefined,
          env,
          location: serverLocation,
        });
      }
      setMcpDialogOpen(false);
      const serversRes = await apiClient.listMCPServers();
      setMcpServers(serversRes);
      // Refresh client-side MCP servers so getClientTools() is up to date
      await refreshClientMCPServers();
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to save MCP server');
    } finally {
      setServerSaving(false);
    }
  };

  const handleDeleteServer = async (server: MCPServer) => {
    try {
      await apiClient.deleteMCPServer(server.id);
      setMcpServers(prev => prev.filter(s => s.id !== server.id));
      if (server.location === 'client') await refreshClientMCPServers();
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to delete MCP server');
    }
  };

  const handleToggleServer = async (server: MCPServer) => {
    try {
      await apiClient.updateMCPServer(server.id, { enabled: !server.enabled });
      setMcpServers(prev =>
        prev.map(s => s.id === server.id ? { ...s, enabled: !s.enabled } : s)
      );
      if (server.location === 'client') await refreshClientMCPServers();
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to toggle MCP server');
    }
  };

  const handleTestServer = async (server: MCPServer) => {
    setTestingServerId(server.id);
    try {
      if (server.location === 'client') {
        if (!window.electron?.mcp) {
          setTestResults(prev => ({ ...prev, [server.id]: { status: 'unavailable', error: 'Electron MCP not available (not running in desktop app)' } }));
          return;
        }
        // Refresh client MCP servers and check if tools were discovered
        await refreshClientMCPServers();
        const tools = getClientTools();
        if (tools.length > 0) {
          setTestResults(prev => ({ ...prev, [server.id]: { status: 'available', tool_count: tools.length } }));
        } else {
          setTestResults(prev => ({ ...prev, [server.id]: { status: 'unavailable', error: 'No tools discovered. Check that the server is running.' } }));
        }
      } else {
        const result = await apiClient.testMCPServer(server.id);
        setTestResults(prev => ({ ...prev, [server.id]: result }));
      }
    } catch (err: any) {
      setTestResults(prev => ({
        ...prev,
        [server.id]: { status: 'unavailable', error: err.message },
      }));
    } finally {
      setTestingServerId(null);
    }
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
        MCP Servers
      </Typography>

      {error && (
        <Box sx={{ mb: 2, color: 'error.main' }}>
          <Typography variant="body2">{error}</Typography>
        </Box>
      )}

      <Box sx={{ maxWidth: 900, mx: 'auto' }}>
        {/* Local Servers Detection */}
        <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
          <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
            Local Servers
          </Typography>
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            {LOCAL_SERVERS.map((svc) => {
              const status = detectedServers[svc.id];
              const isRunning = status?.running;
              const isRegistered = svc.type === 'stdio'
                ? isRunning  // stdio servers are auto-managed, "registered" if running
                : mcpServers.some((s) => s.url && svc.mcpUrl && (s.url === svc.mcpUrl || s.url === svc.mcpUrl.replace('://127.0.0.1:', '://localhost:')));
              return (
                <Box
                  key={svc.id}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    px: 1.5,
                    py: 0.75,
                    borderRadius: 1,
                    border: '1px solid',
                    borderColor: isRunning ? 'success.main' : 'divider',
                    backgroundColor: isRunning ? 'success.main' : 'transparent',
                    opacity: isRunning ? 1 : 0.5,
                  }}
                >
                  <Box
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      backgroundColor: isRunning ? '#fff' : 'text.disabled',
                    }}
                  />
                  <Typography variant="body2" sx={{ fontWeight: 500, color: isRunning ? '#fff' : 'text.secondary' }}>
                    {svc.name}
                  </Typography>
                  {isRunning && status?.version && (
                    <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.7)' }}>
                      v{status.version}
                    </Typography>
                  )}
                  {isRunning && isRegistered && (
                    <Chip label="Connected" size="small" sx={{ height: 20, fontSize: '0.7rem', backgroundColor: 'rgba(255,255,255,0.2)', color: '#fff' }} />
                  )}
                  <IconButton
                    size="small"
                    onClick={() => reconnectLocalServer(svc)}
                    sx={{
                      p: 0.25,
                      color: isRunning ? 'rgba(255,255,255,0.7)' : 'text.disabled',
                      '&:hover': { color: isRunning ? '#fff' : 'text.primary' },
                    }}
                  >
                    <RefreshIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Box>
              );
            })}
          </Box>
        </Paper>

        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
          <Typography variant="body2" color="text.secondary">
            MCP servers provide external tools to your agents via the Model Context Protocol.
          </Typography>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={handleNewServer}
            sx={{ ml: 2, flexShrink: 0 }}
          >
            New Server
          </Button>
        </Box>

        {(() => {
          const localMcpUrls = new Set(LOCAL_SERVERS.filter(s => s.mcpUrl).flatMap((s) => [s.mcpUrl!, s.mcpUrl!.replace('://127.0.0.1:', '://localhost:')]));
          const userServers = mcpServers.filter((s) => !s.url || !localMcpUrls.has(s.url));
          return userServers.length === 0 ? (
          <Paper sx={{ p: 4, textAlign: 'center' }}>
            <DnsIcon sx={{ fontSize: 48, color: 'text.disabled', mb: 2 }} />
            <Typography variant="h6" gutterBottom>
              No MCP Servers
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 2 }}>
              Add an MCP server to provide external tools to your agents.
            </Typography>
            <Button variant="outlined" startIcon={<AddIcon />} onClick={handleNewServer}>
              Add Your First Server
            </Button>
          </Paper>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <AnimatePresence>
              {userServers.map((server, index) => (
                <MotionCard
                  key={server.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ duration: 0.3, delay: index * 0.05 }}
                  sx={{
                    border: '1px solid',
                    borderColor: 'divider',
                    opacity: server.enabled ? 1 : 0.6,
                  }}
                >
                  <CardContent>
                    <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                      <Box sx={{ flex: 1, mr: 2 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                          <DnsIcon fontSize="small" color={server.enabled ? 'primary' : 'disabled'} />
                          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                            {server.name}
                          </Typography>
                          <Chip
                            label={server.transport_type.toUpperCase()}
                            size="small"
                            variant="outlined"
                            color={server.transport_type === 'sse' ? 'primary' : 'secondary'}
                          />
                          <Chip
                            icon={server.location === 'client' ? <ComputerIcon /> : <CloudIcon />}
                            label={server.location === 'client' ? 'Internal' : 'External'}
                            size="small"
                            variant="outlined"
                            color={server.location === 'client' ? 'warning' : 'default'}
                          />
                          {testResults[server.id] && (
                            <Chip
                              icon={testResults[server.id].status === 'available' ? <CheckCircleIcon /> : <CancelIcon />}
                              label={
                                testResults[server.id].status === 'available'
                                  ? `${testResults[server.id].tool_count} tools`
                                  : 'Unavailable'
                              }
                              size="small"
                              color={testResults[server.id].status === 'available' ? 'success' : 'error'}
                            />
                          )}
                        </Box>
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          sx={{
                            fontFamily: 'monospace',
                            fontSize: '0.75rem',
                            backgroundColor: (t: any) => t.palette.mode === 'light' ? '#f5f5f5' : '#1A1A1A',
                            p: 1,
                            borderRadius: 1,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {server.transport_type === 'sse'
                            ? server.url || '(no URL)'
                            : `${server.command || ''}${server.args?.length ? ' ' + server.args.join(' ') : ''}`
                          }
                        </Typography>
                        {testResults[server.id]?.error && (
                          <Typography variant="caption" color="error" sx={{ mt: 0.5, display: 'block' }}>
                            {testResults[server.id].error}
                          </Typography>
                        )}
                      </Box>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
                        <Switch
                          size="small"
                          checked={server.enabled}
                          onChange={() => handleToggleServer(server)}
                          title={server.enabled ? 'Disable' : 'Enable'}
                        />
                        <IconButton
                          size="small"
                          onClick={() => handleTestServer(server)}
                          title="Test connection"
                          disabled={testingServerId === server.id || !server.enabled}
                        >
                          {testingServerId === server.id
                            ? <CircularProgress size={18} />
                            : <TestIcon fontSize="small" />
                          }
                        </IconButton>
                        <IconButton size="small" onClick={() => handleEditServer(server)} title="Edit">
                          <EditIcon fontSize="small" />
                        </IconButton>
                        <IconButton size="small" onClick={() => handleDeleteServer(server)} title="Delete" color="error">
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Box>
                    </Box>
                  </CardContent>
                </MotionCard>
              ))}
            </AnimatePresence>
          </Box>
        );
        })()}
      </Box>

      {/* MCP Server Editor Dialog */}
      <Dialog
        open={mcpDialogOpen}
        onClose={() => setMcpDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          {editingServer ? 'Edit MCP Server' : 'New MCP Server'}
        </DialogTitle>
        <DialogContent dividers>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, pt: 1 }}>
            <TextField
              label="Server Name"
              value={serverName}
              onChange={(e) => setServerName(e.target.value)}
              fullWidth
              placeholder="e.g., web-search"
            />
            <FormControl fullWidth>
              <InputLabel>Transport Type</InputLabel>
              <Select
                value={serverTransportType}
                label="Transport Type"
                onChange={(e) => setServerTransportType(e.target.value as 'sse' | 'stdio')}
              >
                <MenuItem value="sse">SSE (Server-Sent Events)</MenuItem>
                <MenuItem value="stdio">Stdio (Local Process)</MenuItem>
              </Select>
            </FormControl>
            <FormControl fullWidth>
              <InputLabel>Location</InputLabel>
              <Select
                value={serverLocation}
                label="Location"
                onChange={(e) => setServerLocation(e.target.value as 'server' | 'client')}
              >
                <MenuItem value="server">
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <CloudIcon fontSize="small" />
                    External (Server)
                  </Box>
                </MenuItem>
                <MenuItem value="client">
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <ComputerIcon fontSize="small" />
                    Internal (This Computer)
                  </Box>
                </MenuItem>
              </Select>
            </FormControl>
            {serverTransportType === 'sse' ? (
              <TextField
                label="URL"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                fullWidth
                placeholder="http://localhost:8000/sse"
              />
            ) : (
              <>
                <TextField
                  label="Command"
                  value={serverCommand}
                  onChange={(e) => setServerCommand(e.target.value)}
                  fullWidth
                  placeholder="e.g., npx or python"
                />
                <TextField
                  label="Arguments (one per line)"
                  value={serverArgs}
                  onChange={(e) => setServerArgs(e.target.value)}
                  fullWidth
                  multiline
                  minRows={2}
                  maxRows={6}
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/dir'}
                />
              </>
            )}
            <TextField
              label="Environment Variables (optional, KEY=VALUE per line)"
              value={serverEnv}
              onChange={(e) => setServerEnv(e.target.value)}
              fullWidth
              multiline
              minRows={2}
              maxRows={6}
              placeholder={'API_KEY=sk-xxx\nDEBUG=true'}
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMcpDialogOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleSaveServer}
            disabled={!serverName.trim() || serverSaving}
          >
            {serverSaving ? <CircularProgress size={20} /> : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};
