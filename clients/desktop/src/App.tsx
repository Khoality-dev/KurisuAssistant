import React, { useEffect, useMemo, useState } from 'react';
import { ThemeProvider } from '@mui/material/styles';
import { CssBaseline, Box, CircularProgress } from '@mui/material';
import { createAppTheme } from './theme/theme';
import { useAuthStore } from './store/authStore';
import { LoginWindow } from './components/LoginWindow';
import { MainLayout } from './components/layout/MainLayout';
import { UpdateDialog } from './components/UpdateDialog';
import { UpdateRequiredScreen } from './components/UpdateRequiredScreen';
import { apiClient } from './api/client';
import { WIRE_PROTOCOL } from './constants';
import type { ServerVersionInfo } from './api/types';
// Side-effect import: registers WebSocket listener for client-side MCP servers
import './services/mcpService';

const MainApp: React.FC = () => {
  const [initializing, setInitializing] = useState(true);
  const [versionMismatch, setVersionMismatch] = useState<ServerVersionInfo | null>(null);
  const { isAuthenticated, initializeAuth } = useAuthStore();

  useEffect(() => {
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
    return <UpdateRequiredScreen info={versionMismatch} />;
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
