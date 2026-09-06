import React from 'react';
import { Box, IconButton, Typography } from '@mui/material';
import { CallEnd as CallEndIcon, Mic as MicIcon } from '@mui/icons-material';
import CircularProgress from '@mui/material/CircularProgress';
import { motion, AnimatePresence } from 'framer-motion';
import type { ASRStatus } from '../store/micStore';

interface InteractiveCallBarProps {
  asrStatus: ASRStatus;
  interactionActive: boolean;
  lastTranscript: string;
  isStreaming: boolean;
  isTTSPlaying: boolean;
  onHangUp: () => void;
}

export const InteractiveCallBar: React.FC<InteractiveCallBarProps> = ({
  asrStatus,
  interactionActive,
  lastTranscript,
  isStreaming,
  isTTSPlaying,
  onHangUp,
}) => {
  const statusText = isTTSPlaying
    ? 'Speaking...'
    : isStreaming
      ? 'Thinking...'
      : asrStatus === 'processing'
        ? 'Processing...'
        : interactionActive
          ? 'Listening...'
          : 'Waiting for trigger word...';

  const isListening = asrStatus === 'listening';
  const isProcessing = asrStatus === 'processing';

  return (
    <Box
      sx={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        p: 4,
        bgcolor: 'background.default',
      }}
    >
      {/* Transcript display */}
      <Box sx={{ minHeight: 48, display: 'flex', alignItems: 'center' }}>
        <AnimatePresence mode="wait">
          {lastTranscript && (
            <motion.div
              key={lastTranscript}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25 }}
            >
              <Typography
                variant="body1"
                color="text.secondary"
                sx={{ textAlign: 'center', maxWidth: 480, fontStyle: 'italic' }}
              >
                "{lastTranscript}"
              </Typography>
            </motion.div>
          )}
        </AnimatePresence>
      </Box>

      {/* Mic button with pulse ring */}
      <Box sx={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {isListening && interactionActive && (
          <Box
            sx={{
              position: 'absolute',
              width: 64,
              height: 64,
              borderRadius: '50%',
              border: '2px solid',
              borderColor: 'primary.main',
              animation: 'call-pulse 2s ease-out infinite',
              '@keyframes call-pulse': {
                '0%': { transform: 'scale(1)', opacity: 0.6 },
                '100%': { transform: 'scale(1.8)', opacity: 0 },
              },
            }}
          />
        )}
        <IconButton
          sx={{
            width: 64,
            height: 64,
            backgroundColor: interactionActive
              ? 'primary.main'
              : isListening
                ? 'grey.400'
                : 'grey.300',
            color: interactionActive ? 'white' : 'text.secondary',
            '&:hover': {
              backgroundColor: interactionActive
                ? 'primary.dark'
                : isListening
                  ? 'grey.500'
                  : 'grey.400',
            },
          }}
          disabled
        >
          {isProcessing ? (
            <CircularProgress size={28} sx={{ color: 'inherit' }} />
          ) : (
            <MicIcon sx={{ fontSize: 28 }} />
          )}
        </IconButton>
      </Box>

      {/* Status text */}
      <Typography variant="body2" color="text.secondary">
        {statusText}
      </Typography>

      {/* Hang up button */}
      <IconButton
        onClick={onHangUp}
        sx={{
          width: 48,
          height: 48,
          backgroundColor: 'error.main',
          color: 'white',
          '&:hover': { backgroundColor: 'error.dark' },
        }}
      >
        <CallEndIcon />
      </IconButton>
    </Box>
  );
};
