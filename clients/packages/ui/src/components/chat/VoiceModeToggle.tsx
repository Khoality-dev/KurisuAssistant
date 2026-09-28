import React from 'react';
import { Box, ButtonBase, IconButton, Tooltip } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import HeadsetMicIcon from '@mui/icons-material/HeadsetMic';
import { voiceColors } from '../VoiceModeBar';

interface VoiceModeToggleProps {
  on: boolean;
  /** A narrow chat column: the pill says "On". */
  narrow: boolean;
  /** Voice mode has a problem: the pill carries a dot. */
  attention: boolean;
  onStart: () => void;
  onEnd: () => void;
}

/**
 * Voice mode's control in the chat header (#253, #345). Off, a grey headset
 * icon. On, a solid blue pill that says "Voice mode on" ("On" when the column
 * is narrow): blue is the only saturated colour in the column, so it reads
 * from a distance. A dot on the pill while the voice bar shows a problem.
 */
export const VoiceModeToggle: React.FC<VoiceModeToggleProps> = ({ on, narrow, attention, onStart, onEnd }) => {
  const theme = useTheme();
  const c = voiceColors(theme);

  if (!on) {
    return (
      <Tooltip title="Start voice mode">
        <IconButton size="small" aria-label="Start voice mode" onClick={onStart} sx={{ p: 0.5 }}>
          <HeadsetMicIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
        </IconButton>
      </Tooltip>
    );
  }

  return (
    <Tooltip title="End voice mode">
      <ButtonBase
        aria-label="End voice mode"
        onClick={onEnd}
        sx={{
          position: 'relative',
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: '5px',
          height: 26,
          pl: '7px',
          pr: '10px',
          ml: '3px',
          borderRadius: '13px',
          bgcolor: c.info,
          color: '#FFFFFF',
          boxShadow: `0 0 0 3px ${c.infoRing}`,
          fontFamily: 'inherit',
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: '0.01em',
          whiteSpace: 'nowrap',
          '&:hover': { bgcolor: theme.palette.info.dark },
          '&.Mui-focusVisible': { outline: `2px solid ${c.infoFg}`, outlineOffset: 2 },
        }}
      >
        <HeadsetMicIcon aria-hidden sx={{ fontSize: 16 }} />
        {narrow ? 'On' : 'Voice mode on'}
        {attention && (
          <Box
            data-testid="voice-mode-attention"
            aria-hidden
            sx={{ position: 'absolute', top: -4, right: -4, width: 10, height: 10, borderRadius: '50%', bgcolor: c.warnDot, boxShadow: `0 0 0 2px ${theme.palette.background.default}` }}
          />
        )}
      </ButtonBase>
    </Tooltip>
  );
};
