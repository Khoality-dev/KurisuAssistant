import React from 'react';
import { Box, Button, Typography, Stack } from '@mui/material';
import { WIRE_PROTOCOL, type ServerVersionInfo } from '@kurisu/models';
import { describeMismatch } from '../utils/wireProtocol';

interface Props {
  /** `wire_protocol` may be null when the server refused us but could not be asked which version it is. */
  info: { backend_version: string | null; wire_protocol: number | null } | ServerVersionInfo;
  appVersion?: string;
  /**
   * Leave the gate: sign out and go back to the login form with the server URL
   * editable. Without this the screen was a dead end — the stored URL was the
   * one thing the user could not reach, and the one thing that was wrong (#150).
   */
  onChangeServer: () => void;
}

export const UpdateRequiredScreen: React.FC<Props> = ({ info, appVersion, onChangeServer }) => (
  <Box
    sx={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      bgcolor: 'background.default',
      p: 3,
    }}
  >
    <Stack spacing={1.5} alignItems="center" maxWidth={520} textAlign="center">
      <Typography variant="h5">Update required</Typography>
      <Typography variant="body1">
        {describeMismatch(WIRE_PROTOCOL, info.wire_protocol)}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        App: {appVersion ?? '?'} · wire {WIRE_PROTOCOL}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Server: {info.backend_version ?? '?'} · wire {info.wire_protocol ?? '?'}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ pt: 1 }}>
        Pointed at the wrong server? Change it and sign in again.
      </Typography>
      <Button variant="outlined" onClick={onChangeServer}>
        Change server
      </Button>
    </Stack>
  </Box>
);
