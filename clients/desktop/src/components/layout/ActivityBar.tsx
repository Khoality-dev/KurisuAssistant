import React from 'react';
import { Box, IconButton, Tooltip } from '@mui/material';
import {
  FolderOutlined as FolderIcon,
  Folder as FolderFilledIcon,
  ChatBubbleOutline as ChatIcon,
  ChatBubble as ChatFilledIcon,
  SettingsOutlined as SettingsIcon,
  Settings as SettingsFilledIcon,
  Logout as LogoutIcon,
} from '@mui/icons-material';
import { useLayoutStore, type ActivePage } from '../../store/layoutStore';
import { useConnectionStatus } from '../../hooks/useConnectionStatus';
import { wsManager } from '../../api/websocket';
import { useAuthStore } from '../../store/authStore';

interface NavItem {
  id: ActivePage;
  label: string;
  icon: React.ReactNode;
  activeIcon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'workspace', label: 'Workspace', icon: <FolderIcon />, activeIcon: <FolderFilledIcon /> },
  { id: 'conversations', label: 'Conversations', icon: <ChatIcon />, activeIcon: <ChatFilledIcon /> },
  { id: 'settings', label: 'Settings', icon: <SettingsIcon />, activeIcon: <SettingsFilledIcon /> },
];

export const ActivityBar: React.FC = () => {
  const { activePage, setActivePage } = useLayoutStore();
  const connectionStatus = useConnectionStatus();
  const { logout } = useAuthStore();

  const statusColor = connectionStatus === 'connected' ? 'success.main'
    : connectionStatus === 'connecting' ? 'warning.main' : 'error.main';

  return (
    <Box
      sx={{
        width: 52,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        bgcolor: (t) => t.palette.mode === 'light' ? '#F0F0F0' : '#0F0F0F',
        borderRight: 1,
        borderColor: 'divider',
        py: 1,
      }}
    >
      {/* Navigation icons */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, alignItems: 'center', flex: 1 }}>
        {NAV_ITEMS.map((item) => {
          const isActive = activePage === item.id;
          return (
            <Tooltip key={item.id} title={item.label} placement="right">
              <Box sx={{ position: 'relative' }}>
                {isActive && (
                  <Box
                    sx={{
                      position: 'absolute',
                      left: -8,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      width: 3,
                      height: 24,
                      bgcolor: 'info.main',
                      borderRadius: '0 2px 2px 0',
                    }}
                  />
                )}
                <IconButton
                  onClick={() => setActivePage(item.id)}
                  sx={{
                    color: isActive ? 'text.primary' : 'text.secondary',
                    opacity: isActive ? 1 : 0.6,
                    '&:hover': { opacity: 1 },
                    transition: 'all 150ms ease',
                  }}
                >
                  {isActive ? item.activeIcon : item.icon}
                </IconButton>
              </Box>
            </Tooltip>
          );
        })}
      </Box>

      {/* Bottom utility icons */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, alignItems: 'center' }}>
        {/* Connection status */}
        <Tooltip title={`${connectionStatus === 'connected' ? 'Online' : connectionStatus === 'connecting' ? 'Connecting' : 'Offline'}`} placement="right">
          <IconButton
            size="small"
            onClick={() => connectionStatus !== 'connected' && wsManager.reconnect()}
            sx={{ color: 'text.secondary' }}
          >
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                bgcolor: statusColor,
                transition: 'all 300ms ease',
              }}
            />
          </IconButton>
        </Tooltip>

        {/* Logout */}
        <Tooltip title="Logout" placement="right">
          <IconButton
            size="small"
            onClick={logout}
            sx={{ color: 'text.secondary', opacity: 0.6, '&:hover': { opacity: 1 } }}
          >
            <LogoutIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
};
