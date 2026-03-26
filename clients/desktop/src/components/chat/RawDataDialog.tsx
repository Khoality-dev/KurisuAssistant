import React, { useState } from 'react';
import { Box, Typography, Button, Dialog, DialogTitle, DialogContent, DialogActions, CircularProgress } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { DataObject as DataObjectIcon } from '@mui/icons-material';
import { apiClient } from '../../api/client';
import type { MessageRawData } from '../../api/types';

interface RawDataDialogProps {
  open: boolean;
  onClose: () => void;
  messageId: number | undefined;
}

export const RawDataDialog: React.FC<RawDataDialogProps> = ({ open, onClose, messageId }) => {
  const [rawData, setRawData] = useState<MessageRawData | null>(null);
  const [rawLoading, setRawLoading] = useState(false);

  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';

  // Fetch raw data when dialog opens (if not already loaded)
  const handleEnter = async () => {
    if (!messageId) return;
    if (!rawData) {
      setRawLoading(true);
      try {
        const data = await apiClient.getMessageRaw(messageId);
        setRawData(data);
      } catch (error) {
        console.error('Failed to fetch raw data:', error);
      } finally {
        setRawLoading(false);
      }
    }
  };

  const handleClose = () => {
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="md"
      fullWidth
      TransitionProps={{ onEnter: handleEnter }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <DataObjectIcon />
        Raw LLM Data
      </DialogTitle>
      <DialogContent dividers>
        {rawLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        ) : rawData ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
                Raw Input (messages sent to LLM)
              </Typography>
              <Box
                sx={{
                  backgroundColor: isDark ? '#1A1A1A' : '#F3F4F6',
                  p: 2,
                  borderRadius: 1,
                  overflow: 'auto',
                  maxHeight: 400,
                  fontFamily: 'Consolas, Monaco, monospace',
                  fontSize: '0.8rem',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {rawData.raw_input
                  ? JSON.stringify(rawData.raw_input, null, 2)
                  : 'No raw input data available'}
              </Box>
            </Box>
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
                Raw Output (full LLM response)
              </Typography>
              <Box
                sx={{
                  backgroundColor: isDark ? '#1A1A1A' : '#F3F4F6',
                  p: 2,
                  borderRadius: 1,
                  overflow: 'auto',
                  maxHeight: 400,
                  fontFamily: 'Consolas, Monaco, monospace',
                  fontSize: '0.8rem',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {rawData.raw_output || 'No raw output data available'}
              </Box>
            </Box>
          </Box>
        ) : (
          <Typography color="text.secondary">Failed to load raw data.</Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
};
