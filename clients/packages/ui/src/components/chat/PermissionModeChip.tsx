import React, { useRef, useState } from 'react';
import { Box, Button, Chip, Menu, MenuItem, Typography } from '@mui/material';
import { ExpandMore as ExpandIcon, Shield as ShieldIcon } from '@mui/icons-material';
import type { PermissionMode } from '@kurisu/models';

/**
 * The account's permission mode, beside the chat input (#360). Every tool is
 * always available; this decides which calls wait for the user. It is one
 * setting for the account, so a pick here applies on every device and to
 * background tasks.
 */
interface ModeChoice {
  mode: PermissionMode | 'auto';
  title: string;
  body: string;
  comingSoon?: boolean;
}

const CHOICES: ModeChoice[] = [
  { mode: 'ask', title: 'Always ask', body: 'Every call waits for your approval.' },
  { mode: 'read_only', title: 'Read only', body: 'Looking runs; changing anything is refused.' },
  { mode: 'full', title: 'Full access', body: 'Everything runs without asking.' },
  { mode: 'auto', title: 'Auto', body: 'Kurisu decides which calls need you.', comingSoon: true },
];

export const PERMISSION_MODE_TITLES: Record<PermissionMode, string> = {
  ask: 'Always ask',
  read_only: 'Read only',
  full: 'Full access',
};

// Full access and Read only are told apart from the default at a glance.
const TONE: Record<PermissionMode, 'default' | 'info' | 'error'> = {
  ask: 'default',
  read_only: 'info',
  full: 'error',
};

export interface PermissionModeChipProps {
  mode: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  /** Called as the menu opens, so the caller can refetch a mode changed elsewhere. */
  onOpen?: () => void;
  disabled?: boolean;
}

export const PermissionModeChip: React.FC<PermissionModeChipProps> = ({ mode, onChange, onOpen, disabled }) => {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const tone = TONE[mode];

  return (
    <>
      <Button
        ref={anchorRef}
        size="small"
        variant="outlined"
        color={tone === 'default' ? 'inherit' : tone}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Permission mode: ${PERMISSION_MODE_TITLES[mode]}`}
        startIcon={<ShieldIcon fontSize="small" />}
        endIcon={<ExpandIcon fontSize="small" />}
        onClick={() => { onOpen?.(); setOpen(true); }}
        sx={{ borderRadius: 999, minHeight: 32, px: 1.5, whiteSpace: 'nowrap', ...(tone === 'default' ? { color: 'text.secondary', borderColor: 'divider' } : {}) }}
      >
        {PERMISSION_MODE_TITLES[mode]}
      </Button>
      <Menu
        anchorEl={anchorRef.current}
        open={open}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { width: 320 } } }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 2, pt: 0.5, pb: 1 }}>
          Permission mode · every device
        </Typography>
        {CHOICES.map((choice) => {
          const checked = choice.mode === mode;
          return (
            <MenuItem
              key={choice.mode}
              role="menuitemradio"
              aria-checked={checked}
              disabled={choice.comingSoon}
              selected={checked}
              onClick={() => {
                if (choice.comingSoon || choice.mode === 'auto') return;
                setOpen(false);
                if (!checked) onChange(choice.mode);
              }}
              sx={{ alignItems: 'flex-start', whiteSpace: 'normal', py: 1 }}
            >
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="body2" fontWeight={600} data-mode-title>{choice.title}</Typography>
                  {choice.comingSoon && <Chip label="Coming soon" size="small" color="warning" variant="outlined" />}
                </Box>
                <Typography variant="caption" color="text.secondary">{choice.body}</Typography>
              </Box>
            </MenuItem>
          );
        })}
      </Menu>
    </>
  );
};
