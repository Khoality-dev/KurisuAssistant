import React from 'react';
import { Box, IconButton, Slider, Typography, CircularProgress } from '@mui/material';
import {
  PlayArrow as PlayIcon,
  Pause as PauseIcon,
  SkipNext as SkipIcon,
  Close as CloseIcon,
  VolumeUp as VolumeIcon,
  MusicNote as MusicNoteIcon,
} from '@mui/icons-material';
import { motion, AnimatePresence } from 'framer-motion';
import { useMediaStore } from '../store/mediaStore';

export const MediaPlayerBar: React.FC = () => {
  const { playbackState, currentTrack, queue, volume, isBuffering, pause, resume, skip, stop, setVolume } =
    useMediaStore();

  const isVisible = playbackState !== 'stopped' || isBuffering;

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ y: 64, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 64, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              height: 64,
              px: 2,
              gap: 1.5,
              bgcolor: 'background.paper',
              borderTop: '1px solid',
              borderColor: 'divider',
              flexShrink: 0,
            }}
          >
            {/* Thumbnail */}
            {currentTrack?.thumbnail ? (
              <Box
                component="img"
                src={currentTrack.thumbnail}
                alt=""
                sx={{ width: 48, height: 48, borderRadius: 1, objectFit: 'cover', flexShrink: 0 }}
              />
            ) : (
              <Box
                sx={{
                  width: 48,
                  height: 48,
                  borderRadius: 1,
                  backgroundColor: 'action.hover',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <MusicNoteIcon color="disabled" />
              </Box>
            )}

            {/* Track info */}
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                variant="body2"
                sx={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {currentTrack?.title ?? 'Loading...'}
              </Typography>
              {currentTrack?.artist && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}
                >
                  {currentTrack.artist}
                </Typography>
              )}
            </Box>

            {/* Controls */}
            {isBuffering ? (
              <CircularProgress size={24} />
            ) : (
              <IconButton
                size="small"
                onClick={playbackState === 'playing' ? pause : resume}
              >
                {playbackState === 'playing' ? <PauseIcon /> : <PlayIcon />}
              </IconButton>
            )}

            <IconButton size="small" onClick={skip} disabled={queue.length === 0 && !currentTrack}>
              <SkipIcon />
            </IconButton>

            {/* Volume */}
            <VolumeIcon fontSize="small" color="action" />
            <Slider
              size="small"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(_, v) => setVolume(v as number)}
              sx={{ width: 100 }}
            />

            {/* Stop / Close */}
            <IconButton size="small" onClick={stop}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Box>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
