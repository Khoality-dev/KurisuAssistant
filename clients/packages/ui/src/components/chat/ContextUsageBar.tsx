import React from 'react';
import { Box, LinearProgress, Tooltip } from '@mui/material';

interface ContextUsageBarProps {
  tokenCount: number;
  contextSize: number;
}

/**
 * How full the conversation's context is, as a small bar in the chat header
 * (#343). The exact counts are in the context breakdown; here only the share
 * matters, and it warns as it fills: orange past 80%, red past 90%.
 */
export const ContextUsageBar: React.FC<ContextUsageBarProps> = ({ tokenCount, contextSize }) => {
  const percent = contextSize > 0 ? Math.min(100, Math.round((tokenCount / contextSize) * 100)) : 0;
  const level = tokenCount > contextSize * 0.9 ? 'full' : tokenCount > contextSize * 0.8 ? 'warning' : 'ok';
  const color = level === 'full' ? 'error' : level === 'warning' ? 'warning' : 'primary';

  return (
    <Tooltip title={`Context ${percent}% used`}>
      <Box data-level={level} sx={{ width: 64, display: 'flex', alignItems: 'center' }}>
        <LinearProgress
          variant="determinate"
          value={percent}
          color={color}
          aria-label={`Context ${percent}% used`}
          sx={{ width: '100%', height: 6, borderRadius: 3 }}
        />
      </Box>
    </Tooltip>
  );
};
