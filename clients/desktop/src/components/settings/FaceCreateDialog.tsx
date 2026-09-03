import React, { useState, useCallback, useEffect } from 'react';
import {
  Box,
  Typography,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  IconButton,
} from '@mui/material';
import {
  CameraAlt as CameraAltIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import { apiClient } from '../../api/client';
import { useWebcamCapture, type CapturedPhoto } from '../../hooks/useWebcamCapture';

interface FaceCreateDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (name: string, photoCount: number) => void;
  onError: (message: string) => void;
}

export const FaceCreateDialog: React.FC<FaceCreateDialogProps> = ({ open, onClose, onCreated, onError }) => {
  const [newName, setNewName] = useState('');
  const [capturedPhotos, setCapturedPhotos] = useState<CapturedPhoto[]>([]);
  const [scanning, setScanning] = useState(false);
  const [creating, setCreating] = useState(false);

  const {
    webcamStream,
    webcamVideoRef,
    webcamCanvasRef,
    startWebcam,
    stopWebcam,
    captureFrame,
  } = useWebcamCapture();

  // Attach stream to video element
  useEffect(() => {
    if (webcamVideoRef.current && webcamStream) {
      webcamVideoRef.current.srcObject = webcamStream;
    }
  }, [webcamStream, scanning]);

  const handleStartScan = useCallback(async () => {
    setScanning(true);
    try {
      await startWebcam();
    } catch (err: any) {
      onError(err.message);
      setScanning(false);
    }
  }, [startWebcam, onError]);

  const handleStopScan = useCallback(() => {
    setScanning(false);
    stopWebcam();
  }, [stopWebcam]);

  const handleCapture = useCallback(() => {
    const photo = captureFrame();
    if (photo) {
      setCapturedPhotos((prev) => [...prev, photo]);
    }
  }, [captureFrame]);

  const handleRemoveCapture = useCallback((index: number) => {
    setCapturedPhotos((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleClose = useCallback(() => {
    setScanning(false);
    stopWebcam();
    setNewName('');
    setCapturedPhotos([]);
    onClose();
  }, [stopWebcam, onClose]);

  const handleCreate = async () => {
    if (!newName.trim() || capturedPhotos.length === 0) return;
    setCreating(true);
    try {
      // Create face with first photo
      const face = await apiClient.createFace(newName.trim(), capturedPhotos[0].file);
      // Add remaining photos
      for (let i = 1; i < capturedPhotos.length; i++) {
        await apiClient.addFacePhoto(face.id, capturedPhotos[i].file);
      }
      const name = newName;
      const count = capturedPhotos.length;
      handleClose();
      onCreated(name, count);
    } catch (err: any) {
      const detail = err.response?.data?.detail || err.message;
      onError(`Failed to register face: ${detail}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      {/* Hidden canvas for captures */}
      <canvas ref={webcamCanvasRef} style={{ display: 'none' }} />

      <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
        <DialogTitle>Register New Face</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, mt: 1 }}>
            <TextField
              label="Person's Name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              fullWidth
              required
              helperText="A unique name for this person"
            />

            {scanning ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                <Box
                  sx={{
                    width: '100%',
                    maxWidth: 400,
                    aspectRatio: '4/3',
                    bgcolor: 'black',
                    borderRadius: 2,
                    overflow: 'hidden',
                  }}
                >
                  <video
                    ref={webcamVideoRef}
                    autoPlay
                    playsInline
                    muted
                    style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }}
                  />
                </Box>
                <Box sx={{ display: 'flex', gap: 2 }}>
                  <Button
                    variant="contained"
                    startIcon={<CameraAltIcon />}
                    onClick={handleCapture}
                    disabled={!webcamStream}
                  >
                    Capture
                  </Button>
                  <Button variant="outlined" onClick={handleStopScan}>
                    Stop Camera
                  </Button>
                </Box>
              </Box>
            ) : (
              <Button
                variant="outlined"
                startIcon={<CameraAltIcon />}
                onClick={handleStartScan}
                sx={{ alignSelf: 'flex-start' }}
              >
                Scan Face
              </Button>
            )}

            {/* Captured photos grid */}
            {capturedPhotos.length > 0 && (
              <Box>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                  Captured photos ({capturedPhotos.length})
                </Typography>
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                  {capturedPhotos.map((photo, i) => (
                    <Box
                      key={i}
                      sx={{
                        position: 'relative',
                        width: 80,
                        height: 80,
                        borderRadius: 1,
                        overflow: 'hidden',
                        border: '1px solid',
                        borderColor: 'divider',
                      }}
                    >
                      <img
                        src={photo.preview}
                        alt={`Capture ${i + 1}`}
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                      <IconButton
                        size="small"
                        onClick={() => handleRemoveCapture(i)}
                        sx={{
                          position: 'absolute',
                          top: -4,
                          right: -4,
                          bgcolor: 'error.main',
                          color: 'white',
                          p: '2px',
                          '&:hover': { bgcolor: 'error.dark' },
                        }}
                      >
                        <CloseIcon sx={{ fontSize: 14 }} />
                      </IconButton>
                    </Box>
                  ))}
                </Box>
              </Box>
            )}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleCreate}
            disabled={!newName.trim() || capturedPhotos.length === 0 || creating}
          >
            {creating ? 'Registering...' : `Register (${capturedPhotos.length} photo${capturedPhotos.length !== 1 ? 's' : ''})`}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};
