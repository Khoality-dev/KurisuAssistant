import { createTheme, type Theme } from '@mui/material/styles';

const fontFamily = '"Plus Jakarta Sans", system-ui, -apple-system, sans-serif';

export function createAppTheme(mode: 'light' | 'dark'): Theme {
  const isLight = mode === 'light';

  return createTheme({
    palette: {
      mode,
      primary: {
        main: isLight ? '#171717' : '#E5E5E5',
        light: isLight ? '#404040' : '#F5F5F5',
        dark: isLight ? '#0A0A0A' : '#A3A3A3',
      },
      secondary: {
        main: isLight ? '#6B7280' : '#9CA3AF',
      },
      info: {
        main: '#2563EB',
        light: '#3B82F6',
        dark: '#1D4ED8',
      },
      error: {
        main: '#EF4444',
      },
      success: {
        main: '#22C55E',
      },
      warning: {
        main: '#F59E0B',
      },
      background: {
        default: isLight ? '#FAFAFA' : '#0A0A0A',
        paper: isLight ? '#FFFFFF' : '#141414',
      },
      text: {
        primary: isLight ? '#171717' : '#E5E5E5',
        secondary: isLight ? '#6B7280' : '#737373',
      },
      divider: isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)',
      action: {
        hover: isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.04)',
        selected: isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)',
      },
    },
    typography: {
      fontFamily,
      fontSize: 14,
      h1: { fontSize: '1.75rem', fontWeight: 700, letterSpacing: '-0.02em' },
      h2: { fontSize: '1.375rem', fontWeight: 600, letterSpacing: '-0.01em' },
      h3: { fontSize: '1.125rem', fontWeight: 600 },
      body1: { fontSize: '0.875rem', lineHeight: 1.6 },
      body2: { fontSize: '0.8125rem', lineHeight: 1.5 },
      caption: { fontSize: '0.75rem', lineHeight: 1.4, color: isLight ? '#6B7280' : '#737373' },
      button: { textTransform: 'none', fontWeight: 600, fontSize: '0.8125rem' },
    },
    shape: {
      borderRadius: 6,
    },
    spacing: 8,
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            fontFamily,
            WebkitFontSmoothing: 'antialiased',
            MozOsxFontSmoothing: 'grayscale',
          },
          '::-webkit-scrollbar': {
            width: 6,
            height: 6,
          },
          '::-webkit-scrollbar-track': {
            background: 'transparent',
          },
          '::-webkit-scrollbar-thumb': {
            background: isLight ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.15)',
            borderRadius: 3,
          },
          '::-webkit-scrollbar-thumb:hover': {
            background: isLight ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.25)',
          },
        },
      },
      MuiButton: {
        styleOverrides: {
          root: {
            borderRadius: 6,
            padding: '8px 16px',
            fontSize: '0.8125rem',
            transition: 'all 150ms ease',
          },
          contained: {
            boxShadow: 'none',
            '&:hover': {
              boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
            },
          },
          outlined: {
            borderColor: isLight ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.12)',
          },
        },
      },
      MuiTextField: {
        styleOverrides: {
          root: {
            '& .MuiOutlinedInput-root': {
              borderRadius: 6,
              backgroundColor: isLight ? '#FFFFFF' : '#1A1A1A',
              '& fieldset': {
                borderColor: isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)',
              },
              '&:hover fieldset': {
                borderColor: isLight ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.2)',
              },
              '&.Mui-focused fieldset': {
                borderColor: '#2563EB',
                borderWidth: 1,
              },
            },
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            borderRadius: 8,
            backgroundImage: 'none',
          },
          elevation1: {
            boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
          },
        },
      },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            borderRadius: 6,
            marginBottom: 2,
            transition: 'all 150ms ease',
            '&.Mui-selected': {
              backgroundColor: isLight ? 'rgba(37,99,235,0.08)' : 'rgba(59,130,246,0.12)',
              '&:hover': {
                backgroundColor: isLight ? 'rgba(37,99,235,0.12)' : 'rgba(59,130,246,0.16)',
              },
            },
          },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            borderRadius: 12,
            boxShadow: '0 16px 48px rgba(0,0,0,0.12)',
          },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            fontSize: '0.75rem',
            borderRadius: 4,
            padding: '4px 8px',
          },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: {
            borderRadius: 4,
            fontWeight: 500,
          },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: {
            transition: 'all 150ms ease',
          },
        },
      },
    },
  });
}

// Default export for backward compatibility during migration
export const theme = createAppTheme('light');
