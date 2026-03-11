import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box,
  Typography,
  Button,
  Chip,
  Alert,
  CircularProgress,
  LinearProgress,
  Paper,
} from '@mui/material';
import {
  GetApp as InstallIcon,
  Launch as LaunchIcon,
  SystemUpdateAlt as UpdateIcon,
  DeleteOutline as UninstallIcon,
} from '@mui/icons-material';
import { apiClient } from '../api/client';

const HEALTH_POLL_INTERVAL = 5000;

interface ExtensionConfig {
  id: string;
  name: string;
  description: string;
  healthUrl: string;
  releasesApi: string;
  mcpUrl: string;
  installType: 'installer' | 'portable';
}

const EXTENSIONS: ExtensionConfig[] = [
  {
    id: 'maestro',
    name: 'Maestro',
    description: 'Lightweight YouTube music player with MCP integration',
    healthUrl: 'http://localhost:29170/health',
    releasesApi: 'https://api.github.com/repos/Khoality-dev/Maestro/releases/latest',
    mcpUrl: 'http://localhost:29170/sse',
    installType: 'installer',
  },
  {
    id: 'chronicle',
    name: 'Chronicle',
    description: 'System tray activity logger — keystrokes, clipboard, and window activity',
    healthUrl: 'http://localhost:29172/health',
    releasesApi: 'https://api.github.com/repos/Khoality-dev/keylogger/releases/latest',
    mcpUrl: 'http://localhost:29172/sse',
    installType: 'portable',
  },
];

interface ExtensionStatus {
  running: boolean;
  installed: boolean;
  installedVersion: string | null;
  latestVersion: string | null;
  downloadUrl: string | null;
  mcpRegistered: boolean;
}

interface ExtensionCardProps {
  config: ExtensionConfig;
  status: ExtensionStatus;
  onInstall: () => void;
  onLaunch: () => void;
  onUninstall: () => void;
  installing: boolean;
  downloadProgress: number | null;
}

const ExtensionCard: React.FC<ExtensionCardProps> = ({
  config,
  status,
  onInstall,
  onLaunch,
  onUninstall,
  installing,
  downloadProgress,
}) => {
  const hasUpdate =
    status.installedVersion &&
    status.latestVersion &&
    status.installedVersion !== status.latestVersion;

  return (
    <Paper variant="outlined" sx={{ p: 3, maxWidth: 480 }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 2 }}>
        <Box>
          <Typography variant="h6" fontWeight={600}>
            {config.name}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {config.description}
          </Typography>
        </Box>
        <Chip
          label={status.running ? 'Running' : status.installed ? 'Not Running' : 'Not Installed'}
          color={status.running ? 'success' : 'default'}
          size="small"
        />
      </Box>

      {/* Version info */}
      <Box sx={{ mb: 2 }}>
        {status.installedVersion && (
          <Typography variant="body2" color="text.secondary">
            Installed: v{status.installedVersion}
          </Typography>
        )}
        {status.latestVersion && (
          <Typography variant="body2" color="text.secondary">
            Latest: v{status.latestVersion}
          </Typography>
        )}
      </Box>

      {/* Download progress */}
      {installing && downloadProgress !== null && (
        <Box sx={{ mb: 2 }}>
          <LinearProgress variant="determinate" value={downloadProgress} />
          <Typography variant="caption" color="text.secondary">
            Downloading... {Math.round(downloadProgress)}%
          </Typography>
        </Box>
      )}

      {/* Actions */}
      <Box sx={{ display: 'flex', gap: 1 }}>
        {!status.installed && !installing && (
          <Button
            variant="contained"
            startIcon={<InstallIcon />}
            onClick={onInstall}
            disabled={!status.downloadUrl}
            size="small"
          >
            Install
          </Button>
        )}
        {status.installed && !status.running && !installing && (
          <Button
            variant="contained"
            startIcon={<LaunchIcon />}
            onClick={onLaunch}
            size="small"
          >
            Launch
          </Button>
        )}
        {status.running && (
          <Button
            variant="outlined"
            startIcon={<LaunchIcon />}
            onClick={onLaunch}
            size="small"
          >
            Open
          </Button>
        )}
        {hasUpdate && !installing && (
          <Button
            variant="outlined"
            startIcon={<UpdateIcon />}
            onClick={onInstall}
            disabled={!status.downloadUrl}
            size="small"
          >
            Update
          </Button>
        )}
        {status.installed && !status.running && !installing && (
          <Button
            variant="outlined"
            color="error"
            startIcon={<UninstallIcon />}
            onClick={onUninstall}
            size="small"
          >
            Uninstall
          </Button>
        )}
        {installing && (
          <Button disabled size="small" startIcon={<CircularProgress size={16} />}>
            Installing...
          </Button>
        )}
      </Box>
    </Paper>
  );
};

export const ExtensionsWindow: React.FC = () => {
  const [statuses, setStatuses] = useState<Record<string, ExtensionStatus>>(() => {
    const initial: Record<string, ExtensionStatus> = {};
    for (const ext of EXTENSIONS) {
      initial[ext.id] = {
        running: false,
        installed: false,
        installedVersion: null,
        latestVersion: null,
        downloadUrl: null,
        mcpRegistered: false,
      };
    }
    return initial;
  });
  const [error, setError] = useState('');
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const mcpRegisteredRef = useRef<Set<string>>(new Set());

  // Auto-register MCP server for a running extension
  const ensureMCPRegistered = useCallback(async (ext: ExtensionConfig) => {
    if (mcpRegisteredRef.current.has(ext.id)) return;
    try {
      const servers = await apiClient.listMCPServers();
      const exists = servers.some((s) => s.url === ext.mcpUrl);
      if (!exists) {
        await apiClient.createMCPServer({
          name: ext.name,
          transport_type: 'sse',
          url: ext.mcpUrl,
          location: 'server',
        });
      }
      mcpRegisteredRef.current.add(ext.id);
      setStatuses((prev) => ({
        ...prev,
        [ext.id]: { ...prev[ext.id], mcpRegistered: true },
      }));
    } catch {
      // Ignore — non-critical
    }
  }, []);

  // Poll health for all extensions
  const checkStatuses = useCallback(async () => {
    for (const ext of EXTENSIONS) {
      const data = await window.electron.extensions.checkHealth(ext.healthUrl);
      if (data && data.status === 'ok') {
        setStatuses((prev) => ({
          ...prev,
          [ext.id]: {
            ...prev[ext.id],
            running: true,
            installed: true,
            installedVersion: data.version || null,
          },
        }));
        // Auto-register MCP server
        ensureMCPRegistered(ext);
      } else {
        try {
          const result = await window.electron.extensions.checkInstalled(ext.id);
          setStatuses((prev) => ({
            ...prev,
            [ext.id]: {
              ...prev[ext.id],
              running: false,
              installed: result.installed,
              installedVersion: null,
            },
          }));
        } catch {
          setStatuses((prev) => ({
            ...prev,
            [ext.id]: { ...prev[ext.id], running: false, installed: false, installedVersion: null },
          }));
        }
      }
    }
  }, [ensureMCPRegistered]);

  // Fetch latest releases for all extensions
  useEffect(() => {
    for (const ext of EXTENSIONS) {
      (async () => {
        try {
          const res = await fetch(ext.releasesApi);
          if (!res.ok) return;
          const data = await res.json();
          const version = data.tag_name?.replace(/^v/, '') || null;
          const exeAsset = data.assets?.find((a: any) => a.name?.endsWith('.exe'));
          setStatuses((prev) => ({
            ...prev,
            [ext.id]: {
              ...prev[ext.id],
              latestVersion: version,
              downloadUrl: exeAsset?.browser_download_url || null,
            },
          }));
        } catch {
          // Ignore
        }
      })();
    }
  }, []);

  // Poll health
  useEffect(() => {
    checkStatuses();
    const interval = setInterval(checkStatuses, HEALTH_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [checkStatuses]);

  // Listen for download progress
  useEffect(() => {
    const cleanup = window.electron.extensions.onDownloadProgress((progress) => {
      setDownloadProgress(progress.percent);
    });
    return cleanup;
  }, []);

  const handleInstall = async (ext: ExtensionConfig) => {
    const status = statuses[ext.id];
    if (!status.downloadUrl) return;
    setInstallingId(ext.id);
    setDownloadProgress(0);
    setError('');
    try {
      if (ext.installType === 'portable') {
        await window.electron.extensions.downloadPortable(status.downloadUrl, ext.id);
      } else {
        await window.electron.extensions.downloadAndInstall(status.downloadUrl);
      }
      setInstallingId(null);
      setDownloadProgress(null);
      setTimeout(checkStatuses, 2000);
    } catch (err: any) {
      setError(err.message || 'Installation failed');
      setInstallingId(null);
      setDownloadProgress(null);
    }
  };

  const handleLaunch = async (ext: ExtensionConfig) => {
    try {
      await window.electron.extensions.launchApp(ext.id);
    } catch (err: any) {
      setError(err.message || 'Failed to launch');
    }
  };

  const handleUninstall = async (ext: ExtensionConfig) => {
    setError('');
    try {
      await window.electron.extensions.uninstall(ext.id);
      checkStatuses();
    } catch (err: any) {
      setError(err.message || 'Failed to uninstall');
    }
  };

  return (
    <Box sx={{ flex: 1, overflow: 'auto', p: 3 }}>
      <Typography variant="h5" gutterBottom fontWeight={600}>
        Extensions
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Manage companion applications
      </Typography>

      {error && (
        <Alert severity="error" onClose={() => setError('')} sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {EXTENSIONS.map((ext) => (
          <ExtensionCard
            key={ext.id}
            config={ext}
            status={statuses[ext.id]}
            onInstall={() => handleInstall(ext)}
            onLaunch={() => handleLaunch(ext)}
            onUninstall={() => handleUninstall(ext)}
            installing={installingId === ext.id}
            downloadProgress={installingId === ext.id ? downloadProgress : null}
          />
        ))}
      </Box>
    </Box>
  );
};
