/**
 * The transfer tray.
 *
 * Uploads and downloads have one home, and it is not a modal. A dialog that
 * blocks the window while a gigabyte moves is what this replaces: the explorer
 * stays usable, and progress, failures and cancels all read from the same list.
 *
 * Anchored to the window rather than to the explorer, because a transfer the
 * assistant started keeps running while the user is in Settings or a chat.
 */

import React from 'react';
import {
  Box,
  IconButton,
  LinearProgress,
  Link,
  Paper,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Close as CloseIcon,
  CloudUpload as UploadIcon,
  Download as DownloadIcon,
  ErrorOutline as FailedIcon,
  CheckCircleOutline as DoneIcon,
} from '@mui/icons-material';
import { useTransferStore, type Transfer } from '@kurisu/state';
import { formatBytes } from './DriveQuotaBar';

function statusLine(t: Transfer): string {
  switch (t.status) {
    case 'done':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return t.bytes ? `${Math.round((t.transferred / t.bytes) * 100)}%` : 'Working…';
  }
}

const TransferRow: React.FC<{ transfer: Transfer }> = ({ transfer }) => {
  const cancel = useTransferStore((s) => s.cancel);
  const active = transfer.status === 'active';
  const percent = transfer.bytes ? Math.min(100, (transfer.transferred / transfer.bytes) * 100) : 0;

  return (
    <Box
      sx={{
        display: 'flex',
        gap: 1.25,
        alignItems: 'center',
        px: 1.5,
        py: 1.25,
        borderTop: 1,
        borderColor: 'divider',
      }}
    >
      {transfer.status === 'failed' ? (
        <FailedIcon sx={{ fontSize: 18, color: 'error.main' }} />
      ) : transfer.status === 'done' ? (
        <DoneIcon sx={{ fontSize: 18, color: 'success.main' }} />
      ) : transfer.direction === 'up' ? (
        <UploadIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
      ) : (
        <DownloadIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
      )}

      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
          <Typography variant="body2" noWrap sx={{ flex: 1, fontSize: '0.8rem' }}>
            {transfer.name}
          </Typography>
          <Typography
            variant="caption"
            sx={{
              fontFamily: 'monospace',
              fontSize: '0.68rem',
              color: transfer.status === 'failed' ? 'error.main' : 'text.secondary',
            }}
          >
            {statusLine(transfer)}
          </Typography>
        </Box>

        {active && (
          <LinearProgress
            // A stream with no Content-Length has no percentage to show, and a
            // bar frozen at 0 reads as stuck rather than as unknown.
            variant={transfer.bytes ? 'determinate' : 'indeterminate'}
            value={percent}
            sx={{ height: 3, borderRadius: 2 }}
          />
        )}

        <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: '0.68rem' }} noWrap>
          {transfer.error
            ? transfer.error
            : `${transfer.bytes ? formatBytes(transfer.bytes) : '—'} · ${transfer.note}`}
        </Typography>
      </Box>

      {active && (
        <Tooltip title="Cancel">
          <IconButton size="small" onClick={() => cancel(transfer.id)} sx={{ color: 'error.main' }}>
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  );
};

export const TransferTray: React.FC = () => {
  const { transfers, isTrayOpen, toggleTray, clearFinished } = useTransferStore();

  if (!isTrayOpen) return null;

  return (
    <Paper
      elevation={8}
      sx={{
        position: 'fixed',
        right: 18,
        bottom: 18,
        width: 344,
        borderRadius: 2,
        overflow: 'hidden',
        zIndex: (t) => t.zIndex.snackbar,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1.25 }}>
        <Typography variant="subtitle2" sx={{ flex: 1, fontWeight: 600 }}>
          Transfers
        </Typography>
        {transfers.some((t) => t.status !== 'active') && (
          <Link
            component="button"
            underline="hover"
            onClick={clearFinished}
            sx={{ fontSize: '0.75rem' }}
          >
            Clear finished
          </Link>
        )}
        <IconButton size="small" onClick={() => toggleTray(false)} sx={{ color: 'text.secondary' }}>
          <CloseIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>

      <Box sx={{ maxHeight: 264, overflowY: 'auto' }}>
        {transfers.length === 0 ? (
          <Typography
            variant="body2"
            sx={{ px: 2, py: 3, textAlign: 'center', color: 'text.secondary', fontSize: '0.8rem' }}
          >
            Nothing moving. Upload from the toolbar, or ask Kurisu to put something on the drive.
          </Typography>
        ) : (
          transfers.map((transfer) => <TransferRow key={transfer.id} transfer={transfer} />)
        )}
      </Box>
    </Paper>
  );
};
