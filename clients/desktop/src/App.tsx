import React, { useEffect, useMemo, useState } from 'react';
import { ThemeProvider } from '@mui/material/styles';
import { CssBaseline, Box, CircularProgress } from '@mui/material';
import { createAppTheme } from './theme/theme';
import { useAuthStore } from './store/authStore';
import { LoginWindow } from './components/LoginWindow';
import { MainLayout } from './components/layout/MainLayout';
import { UpdateDialog } from './components/UpdateDialog';
// Side-effect import: registers WebSocket listener for client-side MCP servers
import './services/mcpService';

const MainApp: React.FC = () => {
  const [initializing, setInitializing] = useState(true);
  const { isAuthenticated, initializeAuth } = useAuthStore();

  useEffect(() => {
    const init = async () => {
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
