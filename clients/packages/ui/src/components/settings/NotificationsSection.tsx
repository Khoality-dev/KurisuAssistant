import React from 'react';
import { Box, Paper, Switch, Typography } from '@mui/material';
import {
  Face as AssistantIcon,
  NotificationsActive as ReminderIcon,
  NotificationsOff as OffIcon,
} from '@mui/icons-material';
import { useNotificationStore } from '@kurisu/state';

/**
 * Settings → Notifications (#353): one switch for this device, and what can
 * notify. The phone has the same switch for itself; neither changes the other.
 * What is unread is the bell's, on the activity bar.
 */
export const NotificationsSection: React.FC = () => {
  const enabled = useNotificationStore((s) => s.enabled);
  const setEnabled = useNotificationStore((s) => s.setEnabled);

  return (
    <Box sx={{ maxWidth: 700 }}>
      <Typography variant="h3" sx={{ mb: 1 }}>Notifications</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Each device has its own setting.
      </Typography>

      <Paper variant="outlined" sx={{ p: 2, display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography id="notifications-this-device" variant="body1" sx={{ fontWeight: 600 }}>
            Notifications on this computer
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Arrive when the window is closed or in the background.
          </Typography>
        </Box>
        <Switch
          checked={enabled}
          onChange={(_, on) => setEnabled(on)}
          inputProps={{ 'aria-labelledby': 'notifications-this-device' }}
        />
      </Paper>

      {enabled ? (
        <>
          <Typography variant="caption" sx={{ display: 'block', mb: 1, ...captionSx }}>
            Notification sources
          </Typography>
          <Paper variant="outlined">
            <SourceRow
              icon={<AssistantIcon fontSize="small" />}
              title="The assistant"
              detail="When it, or a task it's running, has something for you. Shown under the persona in use. Clicking opens that conversation."
            />
            <SourceRow
              icon={<ReminderIcon fontSize="small" />}
              title="Calendar reminders"
              detail="When a reminder is due. Clicking opens it in Calendar."
              divider
            />
          </Paper>
        </>
      ) : (
        <Paper
          variant="outlined"
          sx={{ p: 2, display: 'flex', gap: 1.5, alignItems: 'flex-start', bgcolor: 'warning.light', borderColor: 'warning.main' }}
        >
          <OffIcon fontSize="small" />
          <Typography variant="body2">
            This computer won't get reminders or messages from the assistant. They still show in the app, and your other devices still get them.
          </Typography>
        </Paper>
      )}
    </Box>
  );
};

const captionSx = { fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'text.secondary' } as const;

const SourceRow: React.FC<{ icon: React.ReactNode; title: string; detail: string; divider?: boolean }> = ({
  icon,
  title,
  detail,
  divider,
}) => (
  <Box sx={{ display: 'flex', gap: 1.5, p: 2, alignItems: 'flex-start', borderTop: divider ? 1 : 0, borderColor: 'divider' }}>
    <Box sx={{ color: 'text.secondary', mt: 0.25 }}>{icon}</Box>
    <Box>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>{title}</Typography>
      <Typography variant="body2" color="text.secondary">{detail}</Typography>
    </Box>
  </Box>
);
