/**
 * How full Kurisu Drive is, at the foot of the sources tree.
 *
 * Storage on someone else's machine has a ceiling, and the moment to learn that
 * is before an upload is refused — so the bar sits next to the tree rather than
 * only in Settings.
 */

import React, { useEffect, useState } from 'react';
import { Box, LinearProgress, Tooltip, Typography } from '@mui/material';
import { Cloud as CloudIcon } from '@mui/icons-material';
import { apiClient } from '../../api/client';
import { DRIVE_ROOT_LABEL } from '../../api/fileSource';
import { useTransferStore } from '../../store/transferStore';
import type { DriveUsage } from '@kurisu/models';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export const DriveQuotaBar: React.FC = () => {
  const [usage, setUsage] = useState<DriveUsage | null>(null);
  // Refetched when a transfer finishes, so the bar is not stale immediately
  // after the one action most likely to move it.
  const finished = useTransferStore((s) =>
    s.transfers.filter((t) => t.status === 'done').length,
  );

  useEffect(() => {
    let cancelled = false;
    apiClient
      .getDriveUsage()
      .then((next) => {
        if (!cancelled) setUsage(next);
      })
      .catch(() => {
        // Signed out, or the server is not reachable. The tree above already
        // says so; a second error here would only be noise.
        if (!cancelled) setUsage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [finished]);

  if (!usage) return null;

  const percent = usage.quota_bytes > 0
    ? Math.min(100, (usage.used_bytes / usage.quota_bytes) * 100)
    : 0;

  return (
    <Box sx={{ px: 1.5, py: 1, borderTop: 1, borderColor: 'divider', flexShrink: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.75 }}>
        <CloudIcon sx={{ fontSize: 15, color: 'text.secondary' }} />
        <Typography variant="caption" sx={{ flex: 1, color: 'text.secondary', fontSize: '0.72rem' }} noWrap>
          {DRIVE_ROOT_LABEL}
        </Typography>
        <Tooltip title={`${usage.file_count} file${usage.file_count === 1 ? '' : 's'}`}>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.68rem', fontFamily: 'monospace' }}>
            {formatBytes(usage.used_bytes)} of {formatBytes(usage.quota_bytes)}
          </Typography>
        </Tooltip>
      </Box>
      <LinearProgress
        variant="determinate"
        value={percent}
        // Past 90% the next upload is the one that fails, so the bar stops
        // looking like ordinary progress.
        color={percent > 90 ? 'warning' : 'primary'}
        sx={{ height: 4, borderRadius: 2 }}
      />
    </Box>
  );
};
