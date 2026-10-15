import React, { useState } from 'react';
import {
  Badge,
  Box,
  Button,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Popover,
  Tooltip,
  Typography,
} from '@mui/material';
import { NotificationsNone as BellIcon } from '@mui/icons-material';
import { notificationHeading, notificationTarget } from '@kurisu/models';
import { useNotificationStore } from '@kurisu/state';

/**
 * The bell on the activity bar (#353). The badge is the server's unread count,
 * so a notification read on the phone clears here too; the list opens one
 * click away, fresh from the server. Opening an item reads it — on every
 * device — and goes where it points; "Mark all read" reads them all.
 */
export const NotificationBell: React.FC = () => {
  const unread = useNotificationStore((s) => s.unread);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const openNotification = useNotificationStore((s) => s.openNotification);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const refreshUnread = useNotificationStore((s) => s.refreshUnread);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const label = unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications';

  return (
    <>
      <Tooltip title="Notifications" placement="right">
        <IconButton
          aria-label={label}
          onClick={(e) => {
            setAnchor(e.currentTarget);
            void refreshUnread();
          }}
          sx={{ color: 'text.secondary', opacity: 0.6, '&:hover': { opacity: 1 } }}
        >
          <Badge badgeContent={unreadCount} color="error" max={99}>
            <BellIcon />
          </Badge>
        </IconButton>
      </Tooltip>
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ paper: { sx: { width: 360, maxHeight: 480 } } }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', px: 2, py: 1.5, borderBottom: 1, borderColor: 'divider' }}>
          <Typography variant="subtitle2" sx={{ flex: 1 }}>Unread</Typography>
          {unread.length > 0 && (
            <Button size="small" onClick={markAllRead}>Mark all read</Button>
          )}
        </Box>
        {unread.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>Nothing unread</Typography>
        ) : (
          <List disablePadding>
            {unread.map((n, i) => (
              <ListItemButton
                key={n.id}
                divider={i < unread.length - 1}
                onClick={() => {
                  setAnchor(null);
                  openNotification({ target: notificationTarget(n), id: n.id });
                }}
              >
                <ListItemText
                  primary={notificationHeading(n)}
                  secondary={n.body || undefined}
                  primaryTypographyProps={{ variant: 'body2', fontWeight: 600 }}
                />
                <Typography variant="caption" color="text.secondary" sx={{ ml: 2, whiteSpace: 'nowrap' }}>
                  {new Date(n.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </Typography>
              </ListItemButton>
            ))}
          </List>
        )}
      </Popover>
    </>
  );
};
