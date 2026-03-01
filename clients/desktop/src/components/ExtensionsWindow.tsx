import React, { useState, useEffect, useCallback } from 'react';
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
} from '@mui/icons-material';

const MAESTRO_HEALTH_URL = 'http://localhost:29170/health';
const MAESTRO_RELEASES_API = 'https://api.github.com/repos/Khoality-dev/Maestro/releases/latest';
const HEALTH_POLL_INTERVAL = 5000;

interface MaestroStatus {
  running: boolean;
  installed: boolean;
  installedVersion: string | null;
}

export const ExtensionsWindow: React.FC = () => {
  const [status, setStatus] = useState<MaestroStatus>({
    running: false,
    installed: false,
    installedVersion: null,
  });
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [installing, setInstalling] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);

  const checkStatus = useCallback(async () => {
    // Health check via IPC (main process) to avoid mixed-content/CORS issues
    const data = await window.electron.extensions.checkHealth(MAESTRO_HEALTH_URL);
    if (data && data.status === 'ok') {
      setStatus({ running: true, installed: true, installedVersion: data.version || null });
    } else {
      try {
        const result = await window.electron.extensions.checkInstalled('maestro');
        setStatus({ running: false, installed: result.installed, installedVersion: null });
      } catch {
        setStatus({ running: false, installed: false, installedVersion: null });
      }
    }
  }, []);

  // Fetch latest release from GitHub
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(MAESTRO_RELEASES_API);
        if (!res.ok) return;
        const data = await res.json();
        setLatestVersion(data.tag_name?.replace(/^v/, '') || null);
        const exeAsset = data.assets?.find((a: any) => a.name?.endsWith('.exe'));
        if (exeAsset) setDownloadUrl(exeAsset.browser_download_url);
      } catch {
        // Ignore — will just not show latest version
      }
    })();
  }, []);

  // Poll health
  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, HEALTH_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [checkStatus]);

  // Listen for download progress
  useEffect(() => {
    const cleanup = window.electron.extensions.onDownloadProgress((progress) => {
      setDownloadProgress(progress.percent);
    });
    return cleanup;
  }, []);

  const handleInstall = async () => {
    if (!downloadUrl) return;
    setInstalling(true);
    setDownloadProgress(0);
    setError('');
    try {
      await window.electron.extensions.downloadAndInstall(downloadUrl);
      setInstalling(false);
      setDownloadProgress(null);
      setTimeout(checkStatus, 2000);
    } catch (err: any) {
      setError(err.message || 'Installation failed');
      setInstalling(false);
      setDownloadProgress(null);
    }
  };

  const handleLaunch = async () => {
    try {
      await window.electron.extensions.launchApp('maestro');
    } catch (err: any) {
      setError(err.message || 'Failed to launch');
    }
  };

  const hasUpdate =
    status.installedVersion &&
    latestVersion &&
    status.installedVersion !== latestVersion;

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

      {/* Maestro Card */}
      <Paper variant="outlined" sx={{ p: 3, maxWidth: 480 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 2 }}>
          <Box>
            <Typography variant="h6" fontWeight={600}>
              Maestro
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Lightweight YouTube music player with MCP integration
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
          {latestVersion && (
            <Typography variant="body2" color="text.secondary">
              Latest: v{latestVersion}
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
              onClick={handleInstall}
              disabled={!downloadUrl}
              size="small"
            >
              Install
            </Button>
          )}
          {status.installed && !status.running && !installing && (
            <Button
              variant="contained"
              startIcon={<LaunchIcon />}
              onClick={handleLaunch}
              size="small"
            >
              Launch
            </Button>
          )}
          {status.running && (
            <Button
              variant="outlined"
              startIcon={<LaunchIcon />}
              onClick={handleLaunch}
              size="small"
            >
              Open
            </Button>
          )}
          {hasUpdate && !installing && (
            <Button
              variant="outlined"
              startIcon={<UpdateIcon />}
              onClick={handleInstall}
              disabled={!downloadUrl}
              size="small"
            >
              Update
            </Button>
          )}
          {installing && (
            <Button disabled size="small" startIcon={<CircularProgress size={16} />}>
              Installing...
            </Button>
          )}
        </Box>
      </Paper>
    </Box>
  );
};
