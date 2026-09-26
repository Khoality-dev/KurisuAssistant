/**
 * The character, inline in the chat column above the messages (#241).
 *
 * The same stack the second window draws — every persona in the conversation,
 * one live 3D stage, the rest as cards — read from the same feed store, with
 * the same subtitle queue under it. It is the character surface on every host,
 * and the only one a browser has. On a host with a window it pops out; while
 * it is out the panel draws nothing, so a persona is never live in both.
 */
import React, { forwardRef, useEffect, useState } from 'react';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import OpenInNewOffIcon from '@mui/icons-material/OpenInNewOff';
import CloseIcon from '@mui/icons-material/Close';
import {
  CHARACTER_PANEL_MAX_FRACTION,
  CHARACTER_PANEL_MIN_HEIGHT,
  onCharacterFeed,
  useCharacterStore,
} from '@kurisu/state';
import { CharacterStack } from './CharacterStack';
import { SubtitleQueue, type SubtitleView } from './subtitleQueue';

export interface CharacterPanelProps {
  /** Its height in px. Never under the floor, never over three fifths of the column, so the composer stays on screen. */
  height: number;
  /** The character is in its own window, so this panel only says so. */
  poppedOut: boolean;
  /** The host has a window to pop out into. */
  canPopOut: boolean;
  onPopOut: () => void;
  onPopIn: () => void;
  onHide: () => void;
}

const toolButtonSx = { p: 0.5, bgcolor: 'rgba(255,255,255,0.7)', '&:hover': { bgcolor: 'rgba(255,255,255,0.9)' } } as const;

export const CharacterPanel = forwardRef<HTMLDivElement, CharacterPanelProps>(
  ({ height, poppedOut, canPopOut, onPopOut, onPopIn, onHide }, ref) => {
    if (poppedOut) {
      return (
        <Box
          ref={ref}
          data-testid="character-panel"
          sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 0.75, borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}
        >
          <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
            Showing in its own window
          </Typography>
          <Tooltip title="Bring the character back into the chat">
            <IconButton size="small" aria-label="Pop in character" onClick={onPopIn} sx={{ p: 0.5 }}>
              <OpenInNewOffIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title="Hide the character">
            <IconButton size="small" aria-label="Hide character" onClick={onHide} sx={{ p: 0.5 }}>
              <CloseIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        </Box>
      );
    }

    return (
      <Box
        ref={ref}
        data-testid="character-panel"
        sx={{
          height,
          // min-height beats max-height: in a column too short for both, the floor wins.
          minHeight: CHARACTER_PANEL_MIN_HEIGHT,
          maxHeight: `${CHARACTER_PANEL_MAX_FRACTION * 100}%`,
          flexShrink: 0,
          position: 'relative',
          display: 'flex',
          overflow: 'hidden',
          // The 2D art is drawn for white, as in the second window.
          bgcolor: '#ffffff',
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <InlineStage />
        <Box sx={{ position: 'absolute', top: 6, right: 6, zIndex: 20, display: 'flex', gap: 0.5 }}>
          {canPopOut && (
            <Tooltip title="Show the character in its own window">
              <IconButton size="small" aria-label="Pop out character" onClick={onPopOut} sx={toolButtonSx}>
                <OpenInNewIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title="Hide the character">
            <IconButton size="small" aria-label="Hide character" onClick={onHide} sx={toolButtonSx}>
              <CloseIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>
    );
  },
);
CharacterPanel.displayName = 'CharacterPanel';

/** The stack and its subtitle; mounted only while the panel is drawing. */
const InlineStage: React.FC = () => {
  const personas = useCharacterStore((s) => s.personas);
  const activePersonaId = useCharacterStore((s) => s.activePersonaId);
  const [subtitle, setSubtitle] = useState<SubtitleView>({ text: '', isUser: false, visible: false });

  useEffect(() => {
    const subtitles = new SubtitleQueue(setSubtitle);
    const off = onCharacterFeed((event) => {
      if (event.type === 'subtitle') subtitles.handle(event.subtitle);
    });
    return () => {
      off();
      subtitles.dispose();
    };
  }, []);

  return (
    <>
      {personas.size === 0 ? (
        <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Typography variant="body2" sx={{ color: 'rgba(0,0,0,0.4)' }}>
            Send a message to see personas here
          </Typography>
        </Box>
      ) : (
        // Side by side: the column is wider than it is tall, unlike the window.
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'row' }}>
          <CharacterStack personas={personas} activePersonaId={activePersonaId} />
        </Box>
      )}
      <Box
        sx={{
          position: 'absolute',
          bottom: 28,
          left: 0,
          right: 0,
          zIndex: 10,
          display: 'flex',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
        <Box
          sx={{
            maxWidth: '90%',
            p: subtitle.text ? '6px 16px' : 0,
            bgcolor: 'rgba(0, 0, 0, 0.65)',
            borderRadius: 2,
            color: '#fff',
            fontSize: 14,
            lineHeight: 1.4,
            textAlign: 'center',
            fontStyle: subtitle.isUser ? 'italic' : 'normal',
            opacity: subtitle.visible ? (subtitle.isUser ? 0.7 : 1) : 0,
            transition: 'opacity 0.4s ease',
            wordBreak: 'break-word',
          }}
        >
          {subtitle.text}
        </Box>
      </Box>
    </>
  );
};
