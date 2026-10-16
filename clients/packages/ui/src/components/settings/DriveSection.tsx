/**
 * Settings → Kurisu Drive: how full the drive is.
 *
 * It used to offer its own Read only / Ask before writing / Full access, over
 * per-tool policies. Those are gone (#360): what the assistant may do without
 * asking is the account's one permission mode, beside the chat input, for the
 * drive as for every other tool.
 */

import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  LinearProgress,
  Paper,
  Typography,
} from '@mui/material';
import { apiClient } from '@kurisu/api';
import { config } from '@kurisu/api';
import { formatBytes } from '../explorer/DriveQuotaBar';
import type { DriveUsage } from '@kurisu/models';

export const DriveSection: React.FC = () => {
  const [usage, setUsage] = useState<DriveUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .getDriveUsage()
      .then(setUsage)
      .catch(() => setUsageError('The drive could not be reached. Check the server address in Account.'));
  }, []);

  const percent = usage && usage.quota_bytes > 0
    ? Math.min(100, (usage.used_bytes / usage.quota_bytes) * 100)
    : 0;

  return (
    <Box sx={{ maxWidth: 900, mx: 'auto' }}>
      <Typography variant="h5" sx={{ mb: 0.5, fontWeight: 600 }}>
        Kurisu Drive
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Account storage on your server. Every signed-in client sees the same files;
        the assistant reaches them through drive tools.
      </Typography>

      {usageError && <Alert severity="warning" sx={{ mb: 2 }}>{usageError}</Alert>}

      {usage && (
        <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 1 }}>
            <Typography variant="subtitle2" sx={{ flex: 1, fontWeight: 600 }}>
              Storage
            </Typography>
            <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
              {formatBytes(usage.used_bytes)} of {formatBytes(usage.quota_bytes)}
            </Typography>
          </Box>
          <LinearProgress
            variant="determinate"
            value={percent}
            color={percent > 90 ? 'warning' : 'primary'}
            sx={{ height: 6, borderRadius: 3, mb: 1 }}
          />
          <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.disabled' }}>
            {config.apiBaseUrl} · {usage.file_count} file{usage.file_count === 1 ? '' : 's'} ·
            {' '}up to {formatBytes(usage.max_file_bytes)} per file
          </Typography>
        </Paper>
      )}

      <Typography variant="caption" color="text.secondary">
        Whether the assistant may write to or delete from the drive without asking is the
        permission mode beside the chat input, the same as for every other tool.
      </Typography>
    </Box>
  );
};
