import React, { useEffect, useState } from 'react';
import { resolveBridge } from '@kurisu/platform';
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

type UpdateState = 'idle' | 'available' | 'downloading' | 'ready';

export const UpdateDialog: React.FC = () => {
  const [state, setState] = useState<UpdateState>('idle');
  const [version, setVersion] = useState('');
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const updater = resolveBridge().updater;
    if (!updater) return;

    const unsubs = [
      updater.onUpdateAvailable((info) => {
        setVersion(info.version);
        setState('available');
      }),
      updater.onDownloadProgress((p) => {
        setState('downloading');
        setProgress(p.percent);
      }),
      updater.onUpdateDownloaded((info) => {
        setVersion(info.version);
        setState('ready');
      }),
    ];

    return () => unsubs.forEach((unsub) => unsub());
  }, []);

  if (state === 'idle') return null;

  const handleInstall = () => {
    resolveBridge().updater?.installUpdate();
  };

  const handleClose = () => {
    if (state !== 'downloading') {
      setState('idle');
    }
  };

  return (
    <Dialog open onClose={handleClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        {state === 'ready' ? 'Update Ready' : 'Update Available'}
      </DialogTitle>
      <DialogContent>
        <Typography variant="body1" sx={{ mb: 2 }}>
          {state === 'ready'
            ? `Version ${version} has been downloaded and is ready to install.`
            : `A new version (${version}) is available.`}
        </Typography>
        {state === 'downloading' && (
          <Box>
            <LinearProgress variant="determinate" value={progress} />
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
              {Math.round(progress)}%
            </Typography>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        {state === 'ready' ? (
          <>
            <Button onClick={handleClose}>Later</Button>
            <Button variant="contained" onClick={handleInstall}>
              Restart Now
            </Button>
          </>
        ) : state === 'available' ? (
          <Button onClick={handleClose}>Dismiss</Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
};
