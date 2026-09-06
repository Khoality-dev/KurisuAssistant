import React, { useEffect, useMemo, useState } from 'react';
import { ThemeProvider } from '@mui/material/styles';
import { CssBaseline, Box, CircularProgress } from '@mui/material';
import { createAppTheme } from './theme/theme';
import { useAuthStore } from '@kurisu/state';
import { LoginWindow } from './components/LoginWindow';
import { MainLayout } from './components/layout/MainLayout';
import { UpdateDialog } from './components/UpdateDialog';
import { UpdateRequiredScreen } from './components/UpdateRequiredScreen';
import { apiClient } from '@kurisu/api';
import { wsManager } from '@kurisu/api';
import { WIRE_PROTOCOL } from '@kurisu/models';
// Side-effect import: registers WebSocket listener for client-side MCP servers
import '@kurisu/state';

/** What the update screen needs to say: the server's numbers, or null where it would not tell us. */
interface VersionMismatch {
  backend_version: string | null;
  wire_protocol: number | null;
}

const MainApp: React.FC = () => {
  const [initializing, setInitializing] = useState(true);
  const [versionMismatch, setVersionMismatch] = useState<VersionMismatch | null>(null);
  const { isAuthenticated, initializeAuth, logout } = useAuthStore();

  useEffect(() => {
    // A mismatch can also surface after startup — a 426 on any request, or the
    // socket closing with 4426 — when the server is updated under a running
    // client, or the user points it at another server (#150).
    apiClient.onProtocolMismatch((info) => {
      setVersionMismatch({ backend_version: info.backend_version, wire_protocol: info.server_wire_protocol });
    });
    wsManager.onProtocolMismatch(() => {
      void apiClient.reportProtocolMismatch();
    });

    const init = async () => {
      // Wire-protocol handshake. On unreachable backend we proceed (offline launch
      // still works); only a confirmed mismatch is a hard gate.
      try {
        const info = await apiClient.getServerVersion();
        if (info.wire_protocol !== WIRE_PROTOCOL) {
          setVersionMismatch(info);
          setInitializing(false);
          return;
        }
      } catch {
        // backend unreachable — let the app try to load anyway
      }
      await initializeAuth();
      setInitializing(false);
    };
    init();
  }, [initializeAuth]);

  // The way out of the gate: drop the session and show the login form, whose
  // Server URL field is the thing the user needs to reach.
  const changeServer = () => {
    logout();
    setVersionMismatch(null);
  };

  if (initializing) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'background.default',
        }}
      >
        <CircularProgress size={40} sx={{ color: 'text.secondary' }} />
      </Box>
    );
  }

  if (versionMismatch) {
    return <UpdateRequiredScreen info={versionMismatch} onChangeServer={changeServer} />;
  }

  return isAuthenticated ? <MainLayout /> : <LoginWindow />;
};

export const App: React.FC = () => {
  const [themeMode, setThemeMode] = useState<'light' | 'dark'>(() => {
    try {
      return (localStorage.getItem('kurisu_theme_mode') as 'light' | 'dark') || 'light';
    } catch {
      return 'light';
    }
  });

  const theme = useMemo(() => createAppTheme(themeMode), [themeMode]);

  // Expose theme toggle globally for settings
  useEffect(() => {
    (window as any).__setThemeMode = (mode: 'light' | 'dark') => {
      localStorage.setItem('kurisu_theme_mode', mode);
      setThemeMode(mode);
    };
    (window as any).__getThemeMode = () => themeMode;
  }, [themeMode]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <MainApp />
      <UpdateDialog />
    </ThemeProvider>
  );
};
