import React from 'react';
import { Alert, Box, Button, Typography } from '@mui/material';

interface ScreenErrorBoundaryProps {
  /** What failed, for the console line: "the Assistant settings", "the chat panel". */
  label: string;
  children: React.ReactNode;
}

interface ScreenErrorBoundaryState {
  error: Error | null;
}

/**
 * Keeps a render error inside the screen that threw it (#296).
 *
 * Without one, React unmounts the whole tree on an uncaught render error: the
 * window goes blank, the navigation and the chat go with it, and the error is
 * only in a console nobody has open. This shows the error in the screen's own
 * place instead and logs it with its stack. Give it a `key` that changes with
 * what it wraps — the settings section, the page — so choosing another screen
 * starts clean; Try again renders the same children once more.
 */
export class ScreenErrorBoundary extends React.Component<ScreenErrorBoundaryProps, ScreenErrorBoundaryState> {
  state: ScreenErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ScreenErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error(`[ScreenErrorBoundary] ${this.props.label} failed to render:`, error, info.componentStack);
  }

  private retry = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Box sx={{ p: 3, maxWidth: 720 }}>
        <Alert
          severity="error"
          action={<Button color="inherit" size="small" onClick={this.retry}>Try again</Button>}
        >
          <Typography variant="body2" sx={{ fontWeight: 600 }}>This page could not be shown.</Typography>
          <Typography variant="body2" sx={{ mt: 0.5, fontFamily: 'monospace', wordBreak: 'break-word' }}>
            {error.message || error.name}
          </Typography>
          <Typography variant="caption" sx={{ display: 'block', mt: 1 }}>
            The rest of the app still works. If this keeps happening, report the line above.
          </Typography>
        </Alert>
      </Box>
    );
  }
}
