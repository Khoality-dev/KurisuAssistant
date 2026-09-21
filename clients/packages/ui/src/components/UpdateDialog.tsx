import React from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  LinearProgress,
  Box,
} from '@mui/material';
import { useUpdateFlow } from './useUpdateFlow';

/**
 * The startup updater's prompt. It only ever *reacts*: the main process
 * checks on launch, and this reports what it found. The state is
 * `useUpdateFlow`'s, shared with the update gate (#264), so a download begun
 * from either shows the same progress in both.
 */
export const UpdateDialog: React.FC = () => {
  const { state, install, dismiss } = useUpdateFlow();

  if (state.status !== 'available' && state.status !== 'downloading' && state.status !== 'ready') {
    return null;
  }

  const version = 'version' in state ? state.version : null;

  return (
    <Dialog open onClose={dismiss} maxWidth="xs" fullWidth>
      <DialogTitle>
        {state.status === 'ready' ? 'Update Ready' : 'Update Available'}
      </DialogTitle>
      <DialogContent>
        <Typography variant="body1" sx={{ mb: 2 }}>
          {state.status === 'ready'
            ? `Version ${version} has been downloaded and is ready to install.`
            : `A new version (${version ?? '…'}) is available.`}
        </Typography>
        {state.status === 'downloading' && (
          <Box>
            <LinearProgress variant="determinate" value={state.percent} />
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
              {Math.round(state.percent)}%
            </Typography>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        {state.status === 'ready' ? (
          <>
            <Button onClick={dismiss}>Later</Button>
            <Button variant="contained" onClick={install}>
              Restart Now
            </Button>
          </>
        ) : state.status === 'available' ? (
          <Button onClick={dismiss}>Dismiss</Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
};
