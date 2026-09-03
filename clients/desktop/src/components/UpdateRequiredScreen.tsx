import React from 'react';
import { Box, Typography, Stack } from '@mui/material';
import { WIRE_PROTOCOL } from '../constants';
import type { ServerVersionInfo } from '../api/types';

interface Props {
  info: ServerVersionInfo;
  appVersion?: string;
}

export const UpdateRequiredScreen: React.FC<Props> = ({ info, appVersion }) => (
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
        This app is incompatible with the server. Please update.
      </Typography>
      <Typography variant="body2" color="text.secondary">
        App: {appVersion ?? '?'} · wire {WIRE_PROTOCOL}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Server: {info.backend_version} · wire {info.wire_protocol}
      </Typography>
    </Stack>
  </Box>
);
