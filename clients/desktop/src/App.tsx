import React, { useEffect, useState } from 'react';
import { ThemeProvider } from '@mui/material/styles';
import { CssBaseline, Box, CircularProgress } from '@mui/material';
import { theme } from './theme/theme';
import { useAuthStore } from './store/authStore';
import { LoginWindow } from './components/LoginWindow';
import { MainWindow } from './components/MainWindow';
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
          background: 'linear-gradient(135deg, #2563EB 0%, #1E40AF 100%)',
        }}
      >
        <CircularProgress size={60} sx={{ color: 'white' }} />
      </Box>
    );
  }

  return isAuthenticated ? <MainWindow /> : <LoginWindow />;
};

export const App: React.FC = () => {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <MainApp />
      <UpdateDialog />
    </ThemeProvider>
  );
};
