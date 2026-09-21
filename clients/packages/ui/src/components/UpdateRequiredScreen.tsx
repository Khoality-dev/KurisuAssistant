import React from 'react';
import { Box, Button, LinearProgress, Typography, Stack } from '@mui/material';
import { WIRE_PROTOCOL, type ServerVersionInfo } from '@kurisu/models';
import { describeMismatch, mismatchSide } from '@kurisu/api';
import { resolveBridge } from '@kurisu/platform';
import { RELEASES_URL, useUpdateFlow, type UpdateFlowState } from './useUpdateFlow';

interface Props {
  /** `wire_protocol` may be null when the server refused us but could not be asked which version it is. */
  info: { backend_version: string | null; wire_protocol: number | null } | ServerVersionInfo;
  appVersion?: string | null;
  /**
   * Leave the gate: sign out and go back to the login form with the server URL
   * editable. Without this the screen was a dead end — the stored URL was the
   * one thing the user could not reach, and the one thing that was wrong (#150).
   */
  onChangeServer: () => void;
}

/** The sentence under the offer, for each state of the flow. Exported so the states are a test. */
export function describeUpdateState(state: UpdateFlowState): string | null {
  switch (state.status) {
    case 'idle':
      return null;
    case 'checking':
      return 'Checking for a newer release…';
    case 'available':
      return `Version ${state.version} is available.`;
    case 'downloading':
      return `Downloading ${state.version ?? 'the update'}… ${Math.round(state.percent)}%`;
    case 'ready':
      return `Version ${state.version} is downloaded. Restart to finish.`;
    case 'none':
      return state.version
        ? `You already have the newest release (v${state.version}). The server is what has to be updated.`
        : 'No newer release was found. The server is what has to be updated.';
    case 'unavailable':
      return state.reason;
    case 'error':
      return state.message;
  }
}

export const UpdateRequiredScreen: React.FC<Props> = ({ info, appVersion, onChangeServer }) => {
  const flow = useUpdateFlow();
  const side = mismatchSide(WIRE_PROTOCOL, info.wire_protocol);
  // The server being behind is the operator's to fix; offering this app an
  // update would be the wrong advice #150 removed.
  const offerUpdate = side !== 'server';
  const selfUpdating = flow.hasUpdater && flow.canSelfUpdate !== false;
  const busy = flow.state.status === 'checking' || flow.state.status === 'downloading';
  const note = describeUpdateState(flow.state);

  const openReleases = () => {
    void resolveBridge().openExternal(RELEASES_URL);
  };

  return (
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

        {offerUpdate && (
          <Stack spacing={1} alignItems="center" sx={{ pt: 1, width: '100%' }} data-testid="update-offer">
            {flow.state.status === 'ready' ? (
              <Button variant="contained" onClick={flow.install} data-testid="update-restart">
                Restart to update
              </Button>
            ) : selfUpdating ? (
              <Button variant="contained" onClick={() => { void flow.check(); }} disabled={busy} data-testid="update-now">
                Update now
              </Button>
            ) : (
              <Button variant="contained" onClick={openReleases} data-testid="update-get">
                Get the update
              </Button>
            )}
            {flow.state.status === 'downloading' && (
              <LinearProgress variant="determinate" value={flow.state.percent} sx={{ width: '100%' }} />
            )}
            {!selfUpdating && flow.canSelfUpdate !== null && (
              <Typography variant="body2" color="text.secondary" data-testid="update-note">
                {flow.hasUpdater
                  ? 'This install cannot update itself; the new release opens in your browser to install by hand.'
                  : 'This build cannot update itself; the new release opens in your browser.'}
              </Typography>
            )}
            {note && (
              <Typography variant="body2" color={flow.state.status === 'error' ? 'error.main' : 'text.secondary'} data-testid="update-state">
                {note}
              </Typography>
            )}
          </Stack>
        )}

        <Typography variant="body2" color="text.secondary" sx={{ pt: 1 }}>
          Pointed at the wrong server? Change it and sign in again.
        </Typography>
        <Button variant="outlined" onClick={onChangeServer}>
          Change server
        </Button>
      </Stack>
    </Box>
  );
};
