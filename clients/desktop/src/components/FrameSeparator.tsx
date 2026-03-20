import React from 'react';
import { Box, Chip, Tooltip } from '@mui/material';
import type { FrameInfo } from '../api/types';

interface FrameSeparatorProps {
  frame: FrameInfo;
}

const FrameSeparatorComponent: React.FC<FrameSeparatorProps> = ({ frame }) => {
  const dateStr = frame.created_at
    ? new Date(frame.created_at).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'New session';

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        my: 2,
        gap: 1,
      }}
    >
      <Box sx={{ flex: 1, height: '1px', bgcolor: 'divider' }} />
      <Tooltip title={frame.summary || ''} placement="top" arrow disableHoverListener={!frame.summary}>
        <Chip
          label={dateStr}
          size="small"
          variant="outlined"
          sx={{
            fontSize: '0.7rem',
            height: 22,
            color: 'text.secondary',
            borderColor: 'divider',
          }}
        />
      </Tooltip>
      <Box sx={{ flex: 1, height: '1px', bgcolor: 'divider' }} />
    </Box>
  );
};

export const FrameSeparator = React.memo(FrameSeparatorComponent);
