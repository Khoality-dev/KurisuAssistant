import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box,
  Paper,
  Typography,
  Card,
  CardContent,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Chip,
  Button,
  CircularProgress,
  IconButton,
  Switch,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
} from '@mui/material';
import {
  Extension as ExtensionIcon,
  Dns as DnsIcon,
  Refresh as RefreshIcon,
  CheckCircle as CheckCircleIcon,
  Cancel as CancelIcon,
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  PlayArrow as TestIcon,
  Computer as ComputerIcon,
  Cloud as CloudIcon,
} from '@mui/icons-material';
import { apiClient } from '../../api/client';
import type { Tool, MCPServer, MCPServerTestResult } from '../../api/types';
import { refreshClientMCPServers, getClientTools, getClientToolsByServer } from '../../services/mcpService';

// --- Local server detection ---

interface LocalServer {
  id: string;
  name: string;
  type: 'sse' | 'stdio';
  healthUrl?: string;
  mcpUrl?: string;
  mcpName?: string;
}

const LOCAL_SERVERS: LocalServer[] = [
  { id: 'maestro', name: 'Maestro', type: 'sse', healthUrl: 'http://127.0.0.1:29170/health', mcpUrl: 'http://127.0.0.1:29170/sse' },
  { id: 'chronicle', name: 'Chronicle', type: 'sse', healthUrl: 'http://127.0.0.1:29172/health', mcpUrl: 'http://127.0.0.1:29172/sse' },
  { id: 'playwright', name: 'Playwright', type: 'stdio', mcpName: 'Playwright' },
];

const LOCAL_SERVER_POLL_INTERVAL = 5000;

export const ToolsSection: React.FC = () => {
  // --- Tools state ---
  const [tools, setTools] = useState<{ mcp: Tool[], builtin: Tool[], client: Tool[], mcpServers: Record<string, Tool[]> }>({ mcp: [], builtin: [], client: [], mcpServers: {} });
  const [selectedTool, setSelectedTool] = useState<Tool | null>(null);
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);

  // --- MCP Servers state ---
  const [mcpServers, setMcpServers] = useState<MCPServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // MCP Server editor
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

  // Local service detection
  const [detectedServers, setDetectedServices] = useState<Record<string, { running: boolean; version?: string }>>({});
  const mcpAutoRegistered = useRef<Set<string>>(new Set());

  // --- Tools loading ---

  const applyToolsResponse = async (toolsRes: { mcp_tools: Tool[]; builtin_tools: Tool[]; mcp_servers?: Record<string, Tool[]> }) => {
    const mcpServersMap: Record<string, Tool[]> = { ...(toolsRes.mcp_servers || {}) };
    const allMcpTools = [...toolsRes.mcp_tools];
    const clientGrouped = await getClientToolsByServer();
    for (const [serverName, serverTools] of Object.entries(clientGrouped)) {
      mcpServersMap[serverName] = serverTools as Tool[];
      allMcpTools.push(...(serverTools as Tool[]));
    }
    const clientTools: Tool[] = [];
    if (window.electron?.hostTools) {
      try { clientTools.push(...(await window.electron.hostTools.listTools() as Tool[])); } catch {}
    }
    if (window.electron?.appTools) {
      try { clientTools.push(...(await window.electron.appTools.listTools() as Tool[])); } catch {}
    }
    const mcpToolNames = new Set(allMcpTools.map(t => t.function.name));
    const serverBuiltinNames = new Set(toolsRes.builtin_tools.map(t => t.function.name));
    const dedupedClientTools = clientTools.filter(t =>
      !mcpToolNames.has(t.function.name) && !serverBuiltinNames.has(t.function.name)
    );
    setTools({ mcp: allMcpTools, builtin: toolsRes.builtin_tools, client: dedupedClientTools, mcpServers: mcpServersMap });
  };

  // --- MCP server management ---

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const [toolsRes, serversRes] = await Promise.all([
        apiClient.listTools(),
        apiClient.listMCPServers(),
      ]);
      await applyToolsResponse(toolsRes);
      setMcpServers(serversRes);
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const registerLocalServer = useCallback(async (svc: LocalServer): Promise<boolean> => {
    if (!svc.mcpUrl) return false;
    // Local companion servers started directly via Electron IPC — not saved to backend DB
    try {
      if (window.electron?.mcp?.startServer) {
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
    mcpAutoRegistered.current.delete(svc.id);
    setDetectedServices((prev) => ({ ...prev, [svc.id]: { running: false } }));

    if (svc.type === 'stdio' && svc.mcpName && window.electron?.mcp?.startServer) {
      const result = await window.electron.mcp.startServer(
        { name: svc.mcpName, transport_type: 'stdio', command: 'npx', args: ['@playwright/mcp'] },
      );
      setDetectedServices((prev) => ({ ...prev, [svc.id]: { running: result.ok } }));
      if (result.ok) await refreshClientMCPServers();
      return;
    }

    if (!window.electron?.extensions || !svc.healthUrl) return;
    const data = await window.electron.extensions.checkHealth(svc.healthUrl);
    const running = !!(data && data.status === 'ok');
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
      await refreshClientMCPServers();
      // Refresh tools too
      const toolsRes = await apiClient.listTools();
      await applyToolsResponse(toolsRes);
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
        await refreshClientMCPServers();
        const clientTools = getClientTools();
        if (clientTools.length > 0) {
          setTestResults(prev => ({ ...prev, [server.id]: { status: 'available', tool_count: clientTools.length } }));
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

  const handleToolClick = (tool: Tool) => {
    setSelectedTool(tool);
    setDetailsDialogOpen(true);
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  const localMcpUrls = new Set(LOCAL_SERVERS.filter(s => s.mcpUrl).flatMap((s) => [s.mcpUrl!, s.mcpUrl!.replace('://127.0.0.1:', '://localhost:')]));
  const userServers = mcpServers.filter((s) => !s.url || !localMcpUrls.has(s.url));

  // Helper to render a consistent server card with tools
  const renderServerCard = (
    name: string,
    subtitle: string | null,
    chips: React.ReactNode,
    serverToolsList: Tool[],
    actions?: React.ReactNode,
  ) => (
    <Card sx={{ border: '1px solid', borderColor: 'divider' }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <Box sx={{ flex: 1, mr: actions ? 2 : 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: subtitle ? 1 : 0 }}>
              <DnsIcon fontSize="small" color="primary" />
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{name}</Typography>
              {chips}
              {serverToolsList.length > 0 && (
                <Chip label={`${serverToolsList.length} tools`} size="small" variant="outlined" />
              )}
            </Box>
            {subtitle && (
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
                {subtitle}
              </Typography>
            )}
          </Box>
          {actions && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
              {actions}
            </Box>
          )}
        </Box>
        {serverToolsList.length > 0 && renderToolGrid(serverToolsList)}
      </CardContent>
    </Card>
  );

  const renderToolGrid = (toolsList: Tool[]) => (
    <Box sx={{ mt: 1.5, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 1 }}>
      {toolsList.map((tool) => (
        <Paper
          key={tool.function.name}
          variant="outlined"
          onClick={() => handleToolClick(tool)}
          sx={{
            p: 1.5,
            cursor: 'pointer',
            '&:hover': { bgcolor: 'action.hover' },
            transition: 'background-color 0.15s',
          }}
        >
          <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
            {tool.function.name}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              lineHeight: 1.3,
            }}
          >
            {tool.function.description || 'No description'}
          </Typography>
        </Paper>
      ))}
    </Box>
  );

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h5" fontWeight={600}>Tools & Servers</Typography>
        <Button variant="contained" size="small" startIcon={<AddIcon />} onClick={handleNewServer}>
          Add MCP Server
        </Button>
      </Box>

      {error && (
        <Box sx={{ mb: 2, color: 'error.main' }}>
          <Typography variant="body2">{error}</Typography>
        </Box>
      )}

      <Box sx={{ maxWidth: 1200, mx: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {/* Built-in tools card (app + server built-in) */}
        {(tools.client.length > 0 || tools.builtin.length > 0) && renderServerCard(
          'Built-in',
          null,
          null,
          [...tools.builtin, ...tools.client],
        )}

        {/* Local servers — same card design */}
        {LOCAL_SERVERS.map((svc) => {
          const status = detectedServers[svc.id];
          const isRunning = status?.running;
          const svcTools = tools.mcpServers[svc.name] || [];
          return (
            <Card
              key={svc.id}
              sx={{
                border: '1px solid',
                borderColor: 'divider',
                opacity: isRunning ? 1 : 0.5,
              }}
            >
              <CardContent>
                <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                  <Box sx={{ flex: 1, mr: 1 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <DnsIcon fontSize="small" color={isRunning ? 'primary' : 'disabled'} />
                      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{svc.name}</Typography>
                      <Chip label="Local" size="small" variant="outlined" color="info" />
                      <Chip
                        label={isRunning ? 'Running' : 'Offline'}
                        size="small"
                        color={isRunning ? 'success' : 'default'}
                        variant={isRunning ? 'filled' : 'outlined'}
                        sx={isRunning ? { color: '#fff' } : {}}
                      />
                      {isRunning && status?.version && (
                        <Typography variant="caption" color="text.secondary">v{status.version}</Typography>
                      )}
                      {svcTools.length > 0 && (
                        <Chip label={`${svcTools.length} tools`} size="small" variant="outlined" />
                      )}
                    </Box>
                  </Box>
                  <IconButton size="small" onClick={() => reconnectLocalServer(svc)} title="Reconnect">
                    <RefreshIcon fontSize="small" />
                  </IconButton>
                </Box>
                {svcTools.length > 0 && renderToolGrid(svcTools)}
              </CardContent>
            </Card>
          );
        })}

        {/* User MCP servers */}
        {userServers.map((server) => {
          const serverTools = tools.mcpServers[server.name] || [];
          return (
            <Card
              key={server.id}
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
                      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{server.name}</Typography>
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
                      {serverTools.length > 0 && (
                        <Chip label={`${serverTools.length} tools`} size="small" variant="outlined" />
                      )}
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
                {serverTools.length > 0 && renderToolGrid(serverTools)}
              </CardContent>
            </Card>
          );
        })}
      </Box>

      {/* Tool Details Dialog */}
      <Dialog
        open={detailsDialogOpen}
        onClose={() => setDetailsDialogOpen(false)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <ExtensionIcon />
            <Typography variant="h6">{selectedTool?.function.name}</Typography>
          </Box>
        </DialogTitle>
        <DialogContent dividers>
          {selectedTool && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Source
                </Typography>
                <Chip
                  label={(() => {
                    const srvName = Object.entries(tools.mcpServers).find(([, serverTools]) =>
                      serverTools.some(t => t.function.name === selectedTool.function.name)
                    )?.[0];
                    return srvName || (selectedTool.built_in ? 'Built-in' : 'Native');
                  })()}
                  color={tools.mcp.some(t => t.function.name === selectedTool.function.name) ? 'primary' : 'secondary'}
                  size="small"
                />
              </Box>
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Description
                </Typography>
                <Typography>
                  {selectedTool.function.description || 'No description available'}
                </Typography>
              </Box>
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Parameters
                </Typography>
                <Paper
                  variant="outlined"
                  sx={{
                    p: 2,
                    backgroundColor: (t: any) => t.palette.mode === 'light' ? '#f5f5f5' : '#1A1A1A',
                    fontFamily: 'monospace',
                    fontSize: '0.85rem',
                    overflow: 'auto',
                    maxHeight: 300,
                  }}
                >
                  <pre style={{ margin: 0 }}>
                    {JSON.stringify(selectedTool.function.parameters, null, 2)}
                  </pre>
                </Paper>
              </Box>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDetailsDialogOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>

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
