import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Box,
  Paper,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Chip,
  Button,
  CircularProgress,
  Switch,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Collapse,
  ButtonBase,
  InputAdornment,
} from '@mui/material';
import {
  Extension as ExtensionIcon,
  Refresh as RefreshIcon,
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  PlayArrow as TestIcon,
  Computer as ComputerIcon,
  Cloud as CloudIcon,
  ChevronRight as ChevronIcon,
  Search as SearchIcon,
} from '@mui/icons-material';
import { apiClient, describeRequestFailure } from '@kurisu/api';
import {
  PLAYWRIGHT_MCP_ARGS,
  PLAYWRIGHT_MCP_PACKAGE,
  type MCPServer,
  type MCPServerTestResult,
  type Tool,
} from '@kurisu/models';
import { refreshClientMCPServers, getClientTools, getClientToolsByServer, useLayoutStore } from '@kurisu/state';
import { buildToolCatalog, matchesQuery, type CatalogGroup, type CatalogTool } from './toolCatalog';
import { requireAppTools, requireExtensions, requireHostTools, requireMcp, resolveBridge } from '@kurisu/platform';

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
  // Everything the assistant has, by where it runs (#360). Nothing here turns a
  // tool on or off; the permission mode beside the chat input decides what waits.
  const [tools, setTools] = useState<{ server: Tool[]; mcpServers: Record<string, Tool[]>; client: Tool[]; clientByServer: Record<string, Tool[]> }>(
    { server: [], mcpServers: {}, client: [], clientByServer: {} },
  );
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
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

  // Whether Playwright starts on its own. The approved command lines and this
  // desktop's MCP endpoint are in Host Access (DesktopProgramsPanel).
  const [playwrightAutostart, setPlaywrightAutostart] = useState(false);

  useEffect(() => {
    resolveBridge().mcp?.getPlaywrightAutostart().then(setPlaywrightAutostart).catch(() => {});
  }, []);

  const setPlaywrightAutostartSetting = useCallback(async (enabled: boolean) => {
    setPlaywrightAutostart(enabled);
    const stored = await resolveBridge().mcp?.setPlaywrightAutostart(enabled);
    if (typeof stored === 'boolean') setPlaywrightAutostart(stored);
  }, []);

  // --- Tools loading ---

  const applyToolsResponse = async (toolsRes: { server_tools: Tool[]; mcp_tools: Tool[]; mcp_servers?: Record<string, Tool[]> }) => {
    const clientByServer = (await getClientToolsByServer()) as Record<string, Tool[]>;
    const client: Tool[] = [];
    if (resolveBridge().hostTools) {
      try { client.push(...(await requireHostTools().listTools() as Tool[])); } catch {}
    }
    if (resolveBridge().appTools) {
      try { client.push(...(await requireAppTools().listTools() as Tool[])); } catch {}
    }
    setTools({ server: toolsRes.server_tools, mcpServers: toolsRes.mcp_servers || {}, client, clientByServer });
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
      setError(describeRequestFailure(err, 'Failed to load data'));
    } finally {
      setLoading(false);
    }
  };

  const registerLocalServer = useCallback(async (svc: LocalServer): Promise<boolean> => {
    if (!svc.mcpUrl) return false;
    // Local companion servers started directly via Electron IPC — not saved to backend DB
    try {
      if (resolveBridge().mcp?.startServer) {
        const result = await requireMcp().startServer({
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
        if (!resolveBridge().extensions) continue;
        const data = await requireExtensions().checkHealth(svc.healthUrl);
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
        if (resolveBridge().mcp) {
          try {
            const grouped = await requireMcp().listToolsByServer();
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

    if (svc.type === 'stdio' && svc.mcpName && resolveBridge().mcp?.startServer) {
      const result = await requireMcp().startServer(
        { name: svc.mcpName, transport_type: 'stdio', command: 'npx', args: [...PLAYWRIGHT_MCP_ARGS] },
      );
      setDetectedServices((prev) => ({ ...prev, [svc.id]: { running: result.ok } }));
      if (result.ok) await refreshClientMCPServers();
      return;
    }

    if (!resolveBridge().extensions || !svc.healthUrl) return;
    const data = await requireExtensions().checkHealth(svc.healthUrl);
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
      setError(describeRequestFailure(err, 'Failed to save MCP server'));
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
      setError(describeRequestFailure(err, 'Failed to delete MCP server'));
    }
  };

  // A server is there or it is removed (#360). One switched off before that has
  // a way back, and nothing switches one off again.
  const handleTurnServerOn = async (server: MCPServer) => {
    try {
      await apiClient.updateMCPServer(server.id, { enabled: true });
      setMcpServers(prev => prev.map(s => s.id === server.id ? { ...s, enabled: true } : s));
      if (server.location === 'client') await refreshClientMCPServers();
      await applyToolsResponse(await apiClient.listTools());
    } catch (err: any) {
      setError(describeRequestFailure(err, 'Failed to turn the MCP server on'));
    }
  };

  const handleTestServer = async (server: MCPServer) => {
    setTestingServerId(server.id);
    try {
      if (server.location === 'client') {
        if (!resolveBridge().mcp) {
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

  const catalog = useMemo(() => buildToolCatalog({
    serverTools: tools.server,
    mcpServers: tools.mcpServers,
    clientTools: tools.client,
    clientToolsByServer: tools.clientByServer,
  }), [tools]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  const localMcpUrls = new Set(LOCAL_SERVERS.filter(s => s.mcpUrl).flatMap((s) => [s.mcpUrl!, s.mcpUrl!.replace('://127.0.0.1:', '://localhost:')]));
  const userServers = mcpServers.filter((s) => !s.url || !localMcpUrls.has(s.url));
  const toolCount = catalog.kurisu.concat(catalog.desktop).reduce((n, g) => n + g.tools.length, 0)
    + Object.values(catalog.mcp).reduce((n, t) => n + t.length, 0);
  const searching = query.trim().length > 0;
  const lendsTools = !!(resolveBridge().hostTools || resolveBridge().appTools || resolveBridge().mcp);

  const effectTag = (t: CatalogTool) => t.effect === 'reads'
    ? <Chip label="Reads" size="small" sx={{ height: 22, fontWeight: 600 }} />
    : <Chip label="Changes" size="small" color="warning" variant="outlined" sx={{ height: 22, fontWeight: 600 }} />;

  const toolRows = (list: CatalogTool[]) => list.filter((t) => matchesQuery(t, query)).map((t) => (
    <ButtonBase
      key={t.name}
      onClick={() => handleToolClick(t.tool)}
      sx={{
        display: 'flex', alignItems: 'center', gap: 2, width: '100%', py: 1, px: 1, borderRadius: 1,
        justifyContent: 'flex-start', textAlign: 'left', borderTop: '1px solid', borderColor: 'divider',
        '&:hover': { bgcolor: 'action.hover' },
      }}
    >
      <Typography variant="body2" sx={{ fontFamily: 'monospace', flex: '0 0 210px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {t.name}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {t.description || 'No description'}
      </Typography>
      {effectTag(t)}
    </ButtonBase>
  ));

  /** One collapsible row: a group of tools, or a server with its tools. */
  const groupRow = (
    id: string,
    name: string,
    list: CatalogTool[],
    extras: { status?: React.ReactNode; detail?: React.ReactNode; actions?: React.ReactNode; dimmed?: boolean } = {},
  ) => {
    const visible = list.filter((t) => matchesQuery(t, query));
    if (searching && visible.length === 0) return null;
    const expanded = searching || !!open[id];
    return (
      <Box key={id} sx={{ '& + &': { borderTop: '1px solid', borderColor: 'divider' }, opacity: extras.dimmed ? 0.7 : 1 }}>
        <ButtonBase
          aria-expanded={expanded}
          onClick={() => setOpen((prev) => ({ ...prev, [id]: !prev[id] }))}
          sx={{ display: 'flex', alignItems: 'center', gap: 1.5, width: '100%', minHeight: 56, px: 2, py: 1, justifyContent: 'flex-start', textAlign: 'left' }}
        >
          <ChevronIcon fontSize="small" sx={{ color: 'text.secondary', transition: 'transform .15s', transform: expanded ? 'rotate(90deg)' : 'none' }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>{name}</Typography>
              {extras.status}
            </Box>
            {extras.detail}
          </Box>
          <Typography variant="caption" color="text.secondary">
            {list.length ? `${list.length} tool${list.length === 1 ? '' : 's'}` : '—'}
          </Typography>
        </ButtonBase>
        <Collapse in={expanded} unmountOnExit>
          <Box sx={{ px: 2, pb: 1.5, pl: 6 }}>
            {visible.length > 0 ? toolRows(visible) : (
              <Typography variant="caption" color="text.secondary">No tools.</Typography>
            )}
            {extras.actions && (
              <Box sx={{ display: 'flex', gap: 1, pt: 1.25, mt: 0.5, borderTop: '1px solid', borderColor: 'divider', flexWrap: 'wrap', alignItems: 'center' }}>
                {extras.actions}
              </Box>
            )}
          </Box>
        </Collapse>
      </Box>
    );
  };

  const section = (title: string, where: string, blurb: string, rows: (React.ReactNode | null)[]) => {
    const present = rows.filter(Boolean);
    if (searching && present.length === 0) return null;
    return (
      <Box component="section" sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.25, flexWrap: 'wrap' }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{title}</Typography>
            <Typography variant="caption" color="text.secondary">{where}</Typography>
          </Box>
          <Typography variant="body2" color="text.secondary">{blurb}</Typography>
        </Box>
        <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
          {present.length ? present : (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>Nothing here yet.</Typography>
          )}
        </Paper>
      </Box>
    );
  };

  const statusChip = (label: string, color: 'success' | 'default' | 'error') => (
    <Chip label={label} size="small" color={color} variant={color === 'default' ? 'outlined' : 'filled'} sx={{ height: 22, ...(color === 'success' ? { color: '#fff' } : {}) }} />
  );
  const mono = (text: string) => (
    <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      {text}
    </Typography>
  );

  const localGroups = catalog.desktop.filter((g) => g.id.startsWith('local:'));
  const hostAndApp = catalog.desktop.filter((g) => !g.id.startsWith('local:'));

  return (
    <Box sx={{ maxWidth: 900, mx: 'auto', display: 'flex', flexDirection: 'column', gap: 3.5 }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
          <Box sx={{ flex: '1 1 360px', minWidth: 0 }}>
            <Typography variant="h5" fontWeight={600}>Tools</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Everything below is available to the assistant. Whether a call waits for you is the
              permission mode beside the chat input.
            </Typography>
          </Box>
          <Button variant="contained" size="small" startIcon={<AddIcon />} onClick={handleNewServer}>
            Add MCP server
          </Button>
        </Box>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
          <TextField
            size="small"
            placeholder={`Search ${toolCount} tools`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            inputProps={{ 'aria-label': 'Search tools' }}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
            sx={{ flex: '1 1 320px' }}
          />
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
            <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'center' }}>
              <Chip label="Reads" size="small" sx={{ height: 22, fontWeight: 600 }} />
              <Typography variant="caption" color="text.secondary">only looks</Typography>
            </Box>
            <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'center' }}>
              <Chip label="Changes" size="small" color="warning" variant="outlined" sx={{ height: 22, fontWeight: 600 }} />
              <Typography variant="caption" color="text.secondary">refused in Read only</Typography>
            </Box>
          </Box>
        </Box>
      </Box>

      {error && (
        <Typography variant="body2" color="error">{error}</Typography>
      )}

      {section('Kurisu', 'on the server, from every device',
        'The assistant’s own features. Always there, wherever you talk to it.',
        catalog.kurisu.map((g: CatalogGroup) => groupRow(`kurisu:${g.id}`, g.name, g.tools)),
      )}

      {lendsTools && section('This desktop', 'lent while this desktop is connected',
        'Run on this computer. A phone or the browser lends none, and never takes these away.',
        [
          ...hostAndApp.map((g) => groupRow(`desktop:${g.id}`, g.name, g.tools, g.id === 'host' ? {
            detail: <Typography variant="caption" color="text.secondary">Only inside the folders granted in Host Access</Typography>,
            actions: (
              <Button size="small" variant="outlined" onClick={() => useLayoutStore.getState().setSettingsSection('host-access')}>
                Host Access
              </Button>
            ),
          } : {})),
          ...LOCAL_SERVERS.map((svc) => {
            const status = detectedServers[svc.id];
            const running = !!status?.running;
            const group = localGroups.find((g) => g.name === (svc.mcpName || svc.name));
            return groupRow(`local:${svc.id}`, svc.name, group?.tools ?? [], {
              status: statusChip(running ? 'Running' : 'Not running', running ? 'success' : 'default'),
              detail: mono(`Local MCP server${svc.mcpUrl ? ` · ${svc.mcpUrl.replace(/^https?:\/\//, '').replace(/\/sse$/, '')}` : ''}${running && status?.version ? ` · v${status.version}` : ''}`),
              dimmed: !running,
              actions: (
                <>
                  <Button size="small" variant="outlined" startIcon={<RefreshIcon />} onClick={() => reconnectLocalServer(svc)}>
                    Reconnect
                  </Button>
                  {svc.id === 'playwright' && resolveBridge().mcp && (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <Switch size="small" checked={playwrightAutostart} onChange={(e) => setPlaywrightAutostartSetting(e.target.checked)} inputProps={{ 'aria-label': 'Start Playwright with the app' }} />
                      <Typography variant="caption" color="text.secondary">
                        Start with the app (runs {PLAYWRIGHT_MCP_PACKAGE} from npm)
                      </Typography>
                    </Box>
                  )}
                </>
              ),
            });
          }),
          ...localGroups
            .filter((g) => !LOCAL_SERVERS.some((svc) => (svc.mcpName || svc.name) === g.name))
            .map((g) => groupRow(g.id, g.name, g.tools, { status: statusChip('Running', 'success'), detail: mono('Local MCP server') })),
        ],
      )}

      {section('MCP servers', 'servers you added',
        'Remove one to take its tools away.',
        userServers.map((server) => {
          const test = testResults[server.id];
          const onThisComputer = server.location === 'client';
          const list = (onThisComputer ? catalog.desktop.find((g) => g.name === server.name)?.tools : catalog.mcp[server.name]) ?? [];
          const status = !server.enabled
            ? statusChip('Turned off', 'default')
            : test
              ? statusChip(test.status === 'available' ? 'Connected' : 'Unreachable', test.status === 'available' ? 'success' : 'error')
              : null;
          return groupRow(`mcp:${server.id}`, server.name, list, {
            status: (
              <>
                {status}
                <Chip
                  icon={onThisComputer ? <ComputerIcon /> : <CloudIcon />}
                  label={onThisComputer ? 'On this computer' : 'On the server'}
                  size="small"
                  variant="outlined"
                  sx={{ height: 22 }}
                />
              </>
            ),
            detail: (
              <>
                {mono(server.transport_type === 'sse'
                  ? server.url || '(no URL)'
                  : `${server.command || ''}${server.args?.length ? ' ' + server.args.join(' ') : ''}`)}
                {test?.error && <Typography variant="caption" color="error" sx={{ display: 'block' }}>{test.error}</Typography>}
              </>
            ),
            dimmed: !server.enabled,
            actions: (
              <>
                {!server.enabled && (
                  <Button size="small" variant="outlined" onClick={() => handleTurnServerOn(server)}>Turn back on</Button>
                )}
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={testingServerId === server.id ? <CircularProgress size={14} /> : <TestIcon />}
                  disabled={testingServerId === server.id || !server.enabled}
                  onClick={() => handleTestServer(server)}
                >
                  Test
                </Button>
                <Button size="small" variant="outlined" startIcon={<EditIcon />} onClick={() => handleEditServer(server)}>Edit</Button>
                <Button size="small" variant="outlined" color="error" startIcon={<DeleteIcon />} onClick={() => handleDeleteServer(server)}>Remove</Button>
              </>
            ),
          });
        }),
      )}

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
            <Typography variant="h6" sx={{ fontFamily: 'monospace' }}>{selectedTool?.function.name}</Typography>
          </Box>
        </DialogTitle>
        <DialogContent dividers>
          {selectedTool && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  In Read only
                </Typography>
                <Typography>
                  {selectedTool.read_only
                    ? 'Runs without asking: it only looks.'
                    : 'Refused: it changes something, or does not say that it only looks.'}
                </Typography>
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
