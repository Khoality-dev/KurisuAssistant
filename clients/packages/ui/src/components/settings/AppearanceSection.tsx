import React, { useState } from 'react';
import {
  Box,
  Typography,
  ToggleButtonGroup,
  ToggleButton,
} from '@mui/material';
import {
  LightMode as LightModeIcon,
  DarkMode as DarkModeIcon,
} from '@mui/icons-material';

export const AppearanceSection: React.FC = () => {
  const [mode, setMode] = useState<'light' | 'dark'>(() => {
    try {
      return (window as any).__getThemeMode?.() || 'light';
    } catch {
      return 'light';
    }
  });

  const handleChange = (_: React.MouseEvent<HTMLElement>, newMode: 'light' | 'dark' | null) => {
    if (newMode === null) return; // Prevent deselecting
    setMode(newMode);
    (window as any).__setThemeMode?.(newMode);
  };

  return (
    <Box sx={{ maxWidth: 700 }}>
      <Typography variant="h3" sx={{ mb: 3 }}>Appearance</Typography>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Choose your preferred color theme.
      </Typography>

      <ToggleButtonGroup
        value={mode}
        exclusive
        onChange={handleChange}
        sx={{ gap: 1, '& .MuiToggleButtonGroup-grouped': { border: 1, borderColor: 'divider', borderRadius: '6px !important' } }}
      >
        <ToggleButton value="light" sx={{ px: 3, py: 1.5, gap: 1 }}>
          <LightModeIcon fontSize="small" />
          Light
        </ToggleButton>
        <ToggleButton value="dark" sx={{ px: 3, py: 1.5, gap: 1 }}>
          <DarkModeIcon fontSize="small" />
          Dark
        </ToggleButton>
      </ToggleButtonGroup>
    </Box>
  );
};
