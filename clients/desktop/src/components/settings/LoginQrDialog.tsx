import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';
import QRCode from 'qrcode';
import { apiClient } from '../../api/client';
import { storage } from '../../utils/storage';

interface Props {
  open: boolean;
  username: string;
  onClose: () => void;
}

export const LoginQrDialog: React.FC<Props> = ({ open, username, onClose }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [password, setPassword] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
  const [generated, setGenerated] = useState(false);

  useEffect(() => {
    if (!open) {
      setPassword('');
      setError('');
      setGenerated(false);
    }
  }, [open]);

  const handleGenerate = async () => {
    if (!password) return;
    setError('');
    setVerifying(true);
    try {
      // Verify the password by attempting a fresh login. We don't persist the
      // resulting token — the current session keeps using its own.
      await apiClient.verifyCredentials(username, password);

      const payload = JSON.stringify({
        v: 1,
        server: storage.getBackendUrl(),
        username,
        password,
      });

      if (canvasRef.current) {
        await QRCode.toCanvas(canvasRef.current, payload, {
          width: 280,
          margin: 2,
          errorCorrectionLevel: 'M',
        });
      }
      setGenerated(true);
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      setError(detail || err?.message || 'Could not verify password');
    } finally {
      setVerifying(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Login QR code</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Re-enter your password to generate a QR code that signs you in on
          another device. The code contains your server URL, username, and
          password — treat it like a credential.
        </Typography>

        {!generated ? (
          <TextField
            fullWidth
            type="password"
            label="Password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && password && !verifying) handleGenerate();
            }}
            disabled={verifying}
            sx={{ mt: 1 }}
          />
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <canvas ref={canvasRef} style={{ borderRadius: 8 }} />
            <Alert severity="warning" sx={{ width: '100%' }}>
              Anyone who scans this can sign in as you. Don't share or screenshot it.
            </Alert>
          </Box>
        )}

        {!generated && error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        {!generated && (
          <Button
            variant="contained"
            disabled={!password || verifying}
            onClick={handleGenerate}
            startIcon={verifying ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            {verifying ? 'Verifying…' : 'Generate'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
};
