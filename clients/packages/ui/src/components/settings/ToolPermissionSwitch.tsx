import React, { useEffect } from 'react';
import { Box, Switch, Typography } from '@mui/material';
import { useToolPermissionsStore } from '@kurisu/state';

/**
 * For a tool allowed by default (#353) — `notify_user` — which runs without
 * asking until the user denies it. On is no stored policy, the tool's own
 * default; off stores a "deny", which the server applies before anything else.
 */
export const ToolPermissionSwitch: React.FC<{ toolName: string }> = ({ toolName }) => {
  const policy = useToolPermissionsStore((s) => s.policy.tools?.[toolName]);
  const setToolPolicy = useToolPermissionsStore((s) => s.setToolPolicy);
  const removeToolPolicy = useToolPermissionsStore((s) => s.removeToolPolicy);
  const loadPolicies = useToolPermissionsStore((s) => s.loadPolicies);
  const denied = policy === 'deny';

  useEffect(() => {
    void loadPolicies?.();
  }, [loadPolicies]);

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <Box sx={{ flex: 1 }}>
        <Typography id={`tool-permission-${toolName}`} variant="body2" sx={{ fontWeight: 600 }}>
          {denied ? 'Denied' : 'Runs without asking'}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {denied ? 'The assistant cannot use it.' : 'Allowed unless you turn it off.'}
        </Typography>
      </Box>
      <Switch
        checked={!denied}
        onChange={(_, on) => (on ? removeToolPolicy(toolName) : setToolPolicy(toolName, 'deny'))}
        inputProps={{ 'aria-labelledby': `tool-permission-${toolName}` }}
      />
    </Box>
  );
};
