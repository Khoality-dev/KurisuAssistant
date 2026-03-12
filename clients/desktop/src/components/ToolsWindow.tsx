import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box,
  Paper,
  Typography,
  IconButton,
  Alert,
  Card,
  CardContent,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Chip,
  Grid,
  Tabs,
  Tab,
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
  Extension as ExtensionIcon,
  Dns as DnsIcon,
  CheckCircle as CheckCircleIcon,
  Cancel as CancelIcon,
  AutoFixHigh as SkillIcon,
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  FileUpload as ImportIcon,
  FileDownload as ExportIcon,
  PlayArrow as TestIcon,
  Computer as ComputerIcon,
  Cloud as CloudIcon,
} from '@mui/icons-material';
import { motion, AnimatePresence } from 'framer-motion';
import { apiClient } from '../api/client';
import type { MCPServer, MCPServerTestResult, Tool, Skill } from '../api/types';
import { refreshClientMCPServers, getClientTools, getClientToolsByServer } from '../services/mcpService';

const MotionCard = motion(Card);

interface LocalService {
  id: string;
  name: string;
  healthUrl: string;
  mcpUrl: string;
}

const LOCAL_SERVICES: LocalService[] = [
  { id: 'maestro', name: 'Maestro', healthUrl: 'http://127.0.0.1:29170/health', mcpUrl: 'http://127.0.0.1:29170/sse' },
  { id: 'chronicle', name: 'Chronicle', healthUrl: 'http://127.0.0.1:29172/health', mcpUrl: 'http://127.0.0.1:29172/sse' },
];

const LOCAL_SERVICE_POLL_INTERVAL = 5000;

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel(props: TabPanelProps) {
  const { children, value, index, ...other } = props;
  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      {...other}
    >
      {value === index && <Box sx={{ p: 3 }}>{children}</Box>}
    </div>
  );
}

export const ToolsWindow: React.FC = () => {
  const [currentTab, setCurrentTab] = useState(0);
  const [mcpServers, setMcpServers] = useState<MCPServer[]>([]);
  const [tools, setTools] = useState<{ mcp: Tool[], builtin: Tool[], mcpServers: Record<string, Tool[]> }>({ mcp: [], builtin: [], mcpServers: {} });
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedTool, setSelectedTool] = useState<Tool | null>(null);
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);

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
  const [detectedServices, setDetectedServices] = useState<Record<string, { running: boolean; version?: string }>>({});
  const mcpAutoRegistered = useRef<Set<string>>(new Set());

  const registerLocalService = useCallback(async (svc: LocalService): Promise<boolean> => {
    try {
      const servers = await apiClient.listMCPServers();
      // Match both localhost and 127.0.0.1 variants, and both server/client locations
      const normalizeUrl = (u: string) => u.replace('://localhost:', '://127.0.0.1:');
      const normalizedMcpUrl = normalizeUrl(svc.mcpUrl);
      const existing = servers.find((s) => s.url && normalizeUrl(s.url) === normalizedMcpUrl);
      if (!existing) {
        console.log(`[LocalServices] Registering client MCP server for ${svc.name} at ${svc.mcpUrl}`);
        await apiClient.createMCPServer({
          name: svc.name,
          transport_type: 'sse',
          url: svc.mcpUrl,
          location: 'client',
        });
      } else {
        // Fix URL or location if needed
        const updates: Record<string, string> = {};
        if (existing.url !== svc.mcpUrl) updates.url = svc.mcpUrl;
        if (existing.location !== 'client') updates.location = 'client';
        if (Object.keys(updates).length > 0) {
          console.log(`[LocalServices] Updating ${svc.name}:`, updates);
          await apiClient.updateMCPServer(existing.id, updates);
        } else {
          console.log(`[LocalServices] ${svc.name} already registered`);
        }
      }
      mcpAutoRegistered.current.add(svc.id);
      // Refresh client MCP connections so Electron connects and registers tools via WebSocket
      await refreshClientMCPServers();
      loadData();
      return true;
    } catch (err) {
      console.error(`[LocalServices] Failed to register ${svc.name}:`, err);
      return false;
    }
  }, []);

  const checkLocalServices = useCallback(async () => {
    if (!window.electron?.extensions) return;
    for (const svc of LOCAL_SERVICES) {
      const data = await window.electron.extensions.checkHealth(svc.healthUrl);
      const running = !!(data && data.status === 'ok');
      setDetectedServices((prev) => ({
        ...prev,
        [svc.id]: { running, version: running ? data?.version : undefined },
      }));
      if (running && !mcpAutoRegistered.current.has(svc.id)) {
        await registerLocalService(svc);
      }
    }
  }, [registerLocalService]);

  const reconnectLocalService = useCallback(async (svc: LocalService) => {
    console.log(`[LocalServices] Reconnecting ${svc.name}...`);
    mcpAutoRegistered.current.delete(svc.id);
    setDetectedServices((prev) => ({ ...prev, [svc.id]: { running: false } }));
    if (!window.electron?.extensions) return;
    const data = await window.electron.extensions.checkHealth(svc.healthUrl);
    const running = !!(data && data.status === 'ok');
    console.log(`[LocalServices] ${svc.name} health check: ${running ? 'OK' : 'FAILED'}`, data);
    setDetectedServices((prev) => ({
      ...prev,
      [svc.id]: { running, version: running ? data?.version : undefined },
    }));
    if (running) {
      await registerLocalService(svc);
    }
  }, [registerLocalService]);

  useEffect(() => {
    checkLocalServices();
    const interval = setInterval(checkLocalServices, LOCAL_SERVICE_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [checkLocalServices]);

  // Skill editor state
  const [skillDialogOpen, setSkillDialogOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const [skillName, setSkillName] = useState('');
  const [skillInstructions, setSkillInstructions] = useState('');
  const [skillSaving, setSkillSaving] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const applyToolsResponse = async (toolsRes: { mcp_tools: Tool[]; builtin_tools: Tool[]; mcp_servers?: Record<string, Tool[]> }) => {
    const mcpServersMap: Record<string, Tool[]> = { ...(toolsRes.mcp_servers || {}) };
    const allMcpTools = [...toolsRes.mcp_tools];
    // Merge client-side tools grouped by server name
    const clientGrouped = await getClientToolsByServer();
    for (const [serverName, serverTools] of Object.entries(clientGrouped)) {
      mcpServersMap[serverName] = serverTools as Tool[];
      allMcpTools.push(...(serverTools as Tool[]));
    }
    setTools({ mcp: allMcpTools, builtin: toolsRes.builtin_tools, mcpServers: mcpServersMap });
  };

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const [serversRes, toolsRes, skillsRes] = await Promise.all([
        apiClient.listMCPServers(),
        apiClient.listTools(),
        apiClient.listSkills(),
      ]);
      setMcpServers(serversRes);
      await applyToolsResponse(toolsRes);
      setSkills(skillsRes);
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleToolClick = (tool: Tool) => {
    setSelectedTool(tool);
    setDetailsDialogOpen(true);
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
      const toolsRes = await apiClient.listTools();
      await applyToolsResponse(toolsRes);
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
      const toolsRes = await apiClient.listTools();
      await applyToolsResponse(toolsRes);
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
        <Typography variant="h6">Tools & Skills</Typography>
        <IconButton onClick={loadData} disabled={loading} title="Refresh">
          <RefreshIcon />
        </IconButton>
      </Paper>

      {/* Tabs */}
      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tabs value={currentTab} onChange={(_, v) => setCurrentTab(v)}>
          <Tab icon={<DnsIcon />} iconPosition="start" label="MCP Servers" />
          <Tab icon={<ExtensionIcon />} iconPosition="start" label="Available Tools" />
          <Tab icon={<SkillIcon />} iconPosition="start" label="Skills" />
        </Tabs>
      </Box>

      {/* Content */}
      <Box sx={{ flex: 1, overflow: 'auto', backgroundColor: '#F7F7F8' }}>
        {/* Alert messages */}
        {error && (
          <Alert severity="error" sx={{ m: 3, maxWidth: 1200, mx: 'auto' }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '50%' }}>
            <CircularProgress />
          </Box>
        ) : (
          <>
            {/* MCP Servers Tab */}
            <TabPanel value={currentTab} index={0}>
              <Box sx={{ maxWidth: 900, mx: 'auto' }}>
                {/* Local Services Detection */}
                <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
                  <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
                    Local Services
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                    {LOCAL_SERVICES.map((svc) => {
                      const status = detectedServices[svc.id];
                      const isRunning = status?.running;
                      const isRegistered = mcpServers.some((s) => s.url && (s.url === svc.mcpUrl || s.url === svc.mcpUrl.replace('://127.0.0.1:', '://localhost:')));
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
                            onClick={() => reconnectLocalService(svc)}
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
                  const localMcpUrls = new Set(LOCAL_SERVICES.flatMap((s) => [s.mcpUrl, s.mcpUrl.replace('://127.0.0.1:', '://localhost:')]));
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
                                    backgroundColor: '#f5f5f5',
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
            </TabPanel>

            {/* Available Tools Tab */}
            <TabPanel value={currentTab} index={1}>
              {tools.mcp.length === 0 && tools.builtin.length === 0 ? (
                <Paper sx={{ p: 4, textAlign: 'center', maxWidth: 600, mx: 'auto' }}>
                  <Typography variant="h6" gutterBottom>
                    No Tools Available
                  </Typography>
                  <Typography color="text.secondary">
                    Tools will appear here once MCP servers are connected or built-in tools are registered.
                  </Typography>
                </Paper>
              ) : (
                <Box sx={{ maxWidth: 1200, mx: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {/* MCP Server groups (grouped view) */}
                  {Object.keys(tools.mcpServers).length > 0 ? (
                    Object.entries(tools.mcpServers).map(([serverName, serverTools]) => (
                      serverTools.length > 0 && (
                        <Box key={serverName}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                            <DnsIcon fontSize="small" color="primary" />
                            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{serverName}</Typography>
                            <Chip label={`${serverTools.length} tools`} size="small" variant="outlined" />
                          </Box>
                          <Grid container spacing={2}>
                            <AnimatePresence>
                              {serverTools.map((tool, index) => (
                                <Grid item xs={12} sm={6} md={4} key={tool.function.name}>
                                  <MotionCard
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -20 }}
                                    transition={{ duration: 0.3, delay: index * 0.05 }}
                                    onClick={() => handleToolClick(tool)}
                                    sx={{
                                      cursor: 'pointer',
                                      border: '1px solid',
                                      borderColor: 'divider',
                                      '&:hover': { boxShadow: 3, transform: 'translateY(-2px)' },
                                      transition: 'box-shadow 0.2s, transform 0.2s',
                                    }}
                                  >
                                    <CardContent>
                                      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
                                        {tool.function.name}
                                      </Typography>
                                      <Typography
                                        variant="body2"
                                        color="text.secondary"
                                        sx={{
                                          overflow: 'hidden',
                                          textOverflow: 'ellipsis',
                                          display: '-webkit-box',
                                          WebkitLineClamp: 3,
                                          WebkitBoxOrient: 'vertical',
                                          minHeight: 60,
                                        }}
                                      >
                                        {tool.function.description || 'No description available'}
                                      </Typography>
                                    </CardContent>
                                  </MotionCard>
                                </Grid>
                              ))}
                            </AnimatePresence>
                          </Grid>
                        </Box>
                      )
                    ))
                  ) : tools.mcp.length > 0 && (
                    /* Fallback: flat MCP list when grouped data unavailable */
                    <Box>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                        <DnsIcon fontSize="small" color="primary" />
                        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>MCP Tools</Typography>
                        <Chip label={`${tools.mcp.length} tools`} size="small" variant="outlined" />
                      </Box>
                      <Grid container spacing={2}>
                        <AnimatePresence>
                          {tools.mcp.map((tool, index) => (
                            <Grid item xs={12} sm={6} md={4} key={tool.function.name}>
                              <MotionCard
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -20 }}
                                transition={{ duration: 0.3, delay: index * 0.05 }}
                                onClick={() => handleToolClick(tool)}
                                sx={{
                                  cursor: 'pointer',
                                  border: '1px solid',
                                  borderColor: 'divider',
                                  '&:hover': { boxShadow: 3, transform: 'translateY(-2px)' },
                                  transition: 'box-shadow 0.2s, transform 0.2s',
                                }}
                              >
                                <CardContent>
                                  <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
                                    {tool.function.name}
                                  </Typography>
                                  <Typography
                                    variant="body2"
                                    color="text.secondary"
                                    sx={{
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      display: '-webkit-box',
                                      WebkitLineClamp: 3,
                                      WebkitBoxOrient: 'vertical',
                                      minHeight: 60,
                                    }}
                                  >
                                    {tool.function.description || 'No description available'}
                                  </Typography>
                                </CardContent>
                              </MotionCard>
                            </Grid>
                          ))}
                        </AnimatePresence>
                      </Grid>
                    </Box>
                  )}

                  {/* Built-in Tools */}
                  {tools.builtin.length > 0 && (
                    <Box>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                        <ExtensionIcon fontSize="small" color="secondary" />
                        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Built-in</Typography>
                        <Chip label={`${tools.builtin.length} tools`} size="small" variant="outlined" />
                      </Box>
                      <Grid container spacing={2}>
                        <AnimatePresence>
                          {tools.builtin.map((tool, index) => (
                            <Grid item xs={12} sm={6} md={4} key={tool.function.name}>
                              <MotionCard
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -20 }}
                                transition={{ duration: 0.3, delay: index * 0.05 }}
                                onClick={() => handleToolClick(tool)}
                                sx={{
                                  cursor: 'pointer',
                                  border: '1px solid',
                                  borderColor: 'divider',
                                  '&:hover': { boxShadow: 3, transform: 'translateY(-2px)' },
                                  transition: 'box-shadow 0.2s, transform 0.2s',
                                }}
                              >
                                <CardContent>
                                  <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
                                    {tool.function.name}
                                  </Typography>
                                  <Typography
                                    variant="body2"
                                    color="text.secondary"
                                    sx={{
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      display: '-webkit-box',
                                      WebkitLineClamp: 3,
                                      WebkitBoxOrient: 'vertical',
                                      minHeight: 60,
                                    }}
                                  >
                                    {tool.function.description || 'No description available'}
                                  </Typography>
                                </CardContent>
                              </MotionCard>
                            </Grid>
                          ))}
                        </AnimatePresence>
                      </Grid>
                    </Box>
                  )}
                </Box>
              )}
            </TabPanel>

            {/* Skills Tab */}
            <TabPanel value={currentTab} index={2}>
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
            </TabPanel>
          </>
        )}
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
              {/* Source */}
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Source
                </Typography>
                <Chip
                  label={(() => {
                    const serverName = Object.entries(tools.mcpServers).find(([, serverTools]) =>
                      serverTools.some(t => t.function.name === selectedTool.function.name)
                    )?.[0];
                    return serverName || (selectedTool.built_in ? 'Built-in' : 'Native');
                  })()}
                  color={tools.mcp.some(t => t.function.name === selectedTool.function.name) ? 'primary' : 'secondary'}
                  size="small"
                />
              </Box>

              {/* Description */}
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Description
                </Typography>
                <Typography>
                  {selectedTool.function.description || 'No description available'}
                </Typography>
              </Box>

              {/* Parameters */}
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Parameters
                </Typography>
                <Paper
                  variant="outlined"
                  sx={{
                    p: 2,
                    backgroundColor: '#f5f5f5',
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
