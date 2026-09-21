/**
 * Which release this app is, which one the backend is, and whether they agree.
 *
 * One number is meant to cover the backend and both clients (#256); these rows
 * are where a person can see it, and the sentence under them is what says the
 * two have drifted apart instead of leaving the numbers to be compared by eye
 * (#257). Android's About screen carries the same rows.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { apiClient } from '@kurisu/api';
import { WIRE_PROTOCOL, versionMismatchSentence, type ServerVersionInfo } from '@kurisu/models';
import { resolveBridge } from '@kurisu/platform';

export interface VersionRowsProps {
  /** How the backend is asked; the default is the real client. Tests inject a stub. */
  fetchServerVersion?: () => Promise<ServerVersionInfo>;
}

type Backend = { state: 'loading' } | { state: 'unreachable' } | { state: 'known'; info: ServerVersionInfo };

const Row: React.FC<{ label: string; value: string; muted?: boolean }> = ({ label, value, muted }) => (
  <Typography
    variant="body2"
    color={muted ? 'text.secondary' : 'text.primary'}
    data-testid={`version-row-${label.toLowerCase()}`}
  >
    {label}: {value}
  </Typography>
);

export const VersionRows: React.FC<VersionRowsProps> = ({
  fetchServerVersion = () => apiClient.getServerVersion(),
}) => {
  const appVersion = resolveBridge().appVersion ?? null;
  const [backend, setBackend] = useState<Backend>({ state: 'loading' });
  // Asked once, on mount. The default fetcher is a fresh closure per render, so
  // it lives in a ref rather than in the effect's dependencies.
  const fetchRef = useRef(fetchServerVersion);
  fetchRef.current = fetchServerVersion;

  useEffect(() => {
    let cancelled = false;
    fetchRef.current()
      .then((info) => { if (!cancelled) setBackend({ state: 'known', info }); })
      .catch(() => { if (!cancelled) setBackend({ state: 'unreachable' }); });
    return () => { cancelled = true; };
  }, []);

  const backendVersion = backend.state === 'known' ? backend.info.backend_version : null;
  const mismatch = versionMismatchSentence(appVersion, backendVersion);

  return (
    <Box sx={{ mb: 4 }}>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        Version
      </Typography>
      {appVersion !== null && <Row label="App" value={`v${appVersion}`} />}
      {backend.state === 'known' ? (
        <Row label="Backend" value={`v${backend.info.backend_version}`} />
      ) : (
        <Row label="Backend" value={backend.state === 'loading' ? 'checking…' : 'unknown'} muted />
      )}
      <Row
        label="Protocol"
        value={
          backend.state === 'known'
            ? `${WIRE_PROTOCOL} (backend ${backend.info.wire_protocol})`
            : `${WIRE_PROTOCOL}`
        }
      />
      {mismatch && (
        <Typography variant="body2" color="warning.main" sx={{ mt: 0.5 }} data-testid="version-mismatch">
          {mismatch}
        </Typography>
      )}
    </Box>
  );
};
