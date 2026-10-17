import React, { useEffect, useState } from 'react';
import { Box, CircularProgress } from '@mui/material';
import { apiClient } from '@kurisu/api';
import { OnboardingDialog } from './OnboardingDialog';

/**
 * Offers a new account its onboarding (#342) before anything else mounts.
 * The server says whether it is owed (`onboarding_pending` on `GET /users/me`):
 * until it is finished or skipped on some device, and never for an account
 * with a persona. The main layout mounts only afterwards, so the chat, its
 * header and the persona store all load what was just chosen. A profile that
 * cannot be read lets the app through rather than locking it.
 */
export const OnboardingGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<'checking' | 'onboarding' | 'ready'>('checking');

  useEffect(() => {
    let alive = true;
    apiClient.getUserProfile()
      .then((profile) => { if (alive) setState(profile.onboarding_pending ? 'onboarding' : 'ready'); })
      .catch(() => { if (alive) setState('ready'); });
    return () => { alive = false; };
  }, []);

  if (state === 'checking') {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', bgcolor: 'background.default' }}>
        <CircularProgress size={32} sx={{ color: 'text.secondary' }} />
      </Box>
    );
  }
  if (state === 'onboarding') {
    return (
      <Box sx={{ height: '100vh', bgcolor: 'background.default' }}>
        <OnboardingDialog onDone={() => setState('ready')} />
      </Box>
    );
  }
  return <>{children}</>;
};
