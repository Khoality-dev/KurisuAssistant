import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Box,
  Typography,
  Button,
  Paper,
  Grid,
  Card,
  CardContent,
  CardActions,
  Avatar,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
  Chip,
  Tooltip,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  Select,
  MenuItem,
  Switch,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  PhotoCamera as PhotoCameraIcon,
  Videocam as VideocamIcon,
  VideocamOff as VideocamOffIcon,
  Person as PersonIcon,
  Refresh as RefreshIcon,
  CameraAlt as CameraAltIcon,
} from '@mui/icons-material';
import { motion, AnimatePresence } from 'framer-motion';
import { apiClient } from '../../api/client';
import { useVisionStore } from '../../store/visionStore';
import { useWebcamCapture } from '../../hooks/useWebcamCapture';
import { FaceCreateDialog } from './FaceCreateDialog';
import type { FaceIdentity, FaceIdentityDetail } from '../../api/types';

const MotionCard = motion(Card);

export const FacesSection: React.FC = () => {
  const [faces, setFaces] = useState<FaceIdentity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  // Create dialog
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  // Webcam (detail dialog scanning)
  const {
    webcamStream,
    webcamVideoRef,
    webcamCanvasRef,
    startWebcam,
    stopWebcam,
    captureFrame,
  } = useWebcamCapture();

  // Vision preview (detection overlay on store's stream)
  const visionVideoRef = useRef<HTMLVideoElement>(null);
  const visionCanvasRef = useRef<HTMLCanvasElement>(null);

  // Detail dialog
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [selectedFace, setSelectedFace] = useState<FaceIdentityDetail | null>(null);
  const [detailScanning, setDetailScanning] = useState(false);

  // Delete dialog
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [faceToDelete, setFaceToDelete] = useState<FaceIdentity | null>(null);

  // Vision
  const {
    isActive: visionActive,
    stream: visionStream,
    latestResult,
    webcams,
    selectedWebcam,
    setSelectedWebcam,
    enableFace,
    setEnableFace,
    enablePose,
    setEnablePose,
    enableHands,
    setEnableHands,
    error: visionError,
    loadWebcams,
    startVision,
    stopVision,
  } = useVisionStore();

  const loadFaces = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiClient.listFaces();
      setFaces(data);
    } catch (err: any) {
      setError('Failed to load faces');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFaces();
    loadWebcams();
  }, [loadFaces, loadWebcams]);

  useEffect(() => {
    if (successMessage) {
      const timer = setTimeout(() => setSuccessMessage(''), 3000);
      return () => clearTimeout(timer);
    }
  }, [successMessage]);

  // Attach store's vision stream to video element for preview
  useEffect(() => {
    if (visionVideoRef.current) {
      visionVideoRef.current.srcObject = visionStream;
    }
  }, [visionStream]);

  // Draw detection overlay on vision canvas
  useEffect(() => {
    const canvas = visionCanvasRef.current;
    const video = visionVideoRef.current;
    if (!canvas || !video || !visionActive || !latestResult) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Match canvas size to video
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const w = canvas.width;
    void canvas.height; // height used implicitly

    // Draw face bounding boxes
    for (const face of latestResult.faces) {
      const [x1, y1, x2, y2] = face.bbox;
      const color = face.identity_id ? '#00c853' : '#ff9100';
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

      // Label
      const label = `${face.name} (${Math.round(face.confidence * 100)}%)`;
      ctx.font = '14px sans-serif';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = color;
      ctx.fillRect(x1, y1 - 20, tw + 8, 20);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x1 + 4, y1 - 5);
    }

    // Draw gesture labels
    for (let i = 0; i < latestResult.gestures.length; i++) {
      const g = latestResult.gestures[i];
      const label = `${g.gesture} (${Math.round(g.confidence * 100)}%)`;
      ctx.font = 'bold 16px sans-serif';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(w - tw - 16, 10 + i * 30, tw + 12, 24);
      ctx.fillStyle = '#00e5ff';
      ctx.fillText(label, w - tw - 10, 28 + i * 30);
    }
  }, [latestResult, visionActive]);

  // Attach stream to video element
  useEffect(() => {
    if (webcamVideoRef.current && webcamStream) {
      webcamVideoRef.current.srcObject = webcamStream;
    }
  }, [webcamStream, detailScanning]);

  // Detail dialog
  const handleOpenDetail = async (face: FaceIdentity) => {
    try {
      const detail = await apiClient.getFace(face.id);
      setSelectedFace(detail);
      setDetailDialogOpen(true);
    } catch (err: any) {
      setError('Failed to load face details');
    }
  };

  const handleDetailStartScan = useCallback(async () => {
    setDetailScanning(true);
    try {
      await startWebcam();
    } catch (err: any) {
      setError(err.message);
      setDetailScanning(false);
    }
  }, [startWebcam]);

  const handleDetailStopScan = useCallback(() => {
    setDetailScanning(false);
    stopWebcam();
  }, [stopWebcam]);

  const handleDetailCapture = useCallback(async () => {
    const photo = captureFrame();
    if (!photo || !selectedFace) return;
    try {
      await apiClient.addFacePhoto(selectedFace.id, photo.file);
      const updated = await apiClient.getFace(selectedFace.id);
      setSelectedFace(updated);
      loadFaces();
      setSuccessMessage('Photo captured and added');
    } catch (err: any) {
      const detail = err.response?.data?.detail || err.message;
      setError(`Failed to add photo: ${detail}`);
    }
  }, [captureFrame, selectedFace, loadFaces]);

  const handleCloseDetail = useCallback(() => {
    setDetailDialogOpen(false);
    setDetailScanning(false);
    stopWebcam();
  }, [stopWebcam]);

  const handleDeletePhoto = async (photoId: number) => {
    if (!selectedFace) return;
    try {
      await apiClient.deleteFacePhoto(selectedFace.id, photoId);
      const updated = await apiClient.getFace(selectedFace.id);
      setSelectedFace(updated);
      loadFaces();
    } catch (err: any) {
      setError('Failed to delete photo');
    }
  };

  const handleDelete = async () => {
    if (!faceToDelete) return;
    try {
      await apiClient.deleteFace(faceToDelete.id);
      setSuccessMessage(`Face "${faceToDelete.name}" deleted`);
      setDeleteDialogOpen(false);
      setFaceToDelete(null);
      loadFaces();
    } catch (err: any) {
      setError('Failed to delete face');
    }
  };

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 3, fontWeight: 600 }}>
        Face Identities
      </Typography>

      {/* Header actions */}
      <Paper
        elevation={0}
        sx={{
          p: 2,
          mb: 3,
          borderBottom: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Typography variant="h6">Faces</Typography>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setCreateDialogOpen(true)}
        >
          Register Face
        </Button>
      </Paper>

      {successMessage && (
        <Alert severity="success" sx={{ mb: 3, maxWidth: 1200, mx: 'auto' }}>
          {successMessage}
        </Alert>
      )}
      {(error || visionError) && (
        <Alert
          severity="error"
          sx={{ mb: 3, maxWidth: 1200, mx: 'auto' }}
          onClose={() => setError('')}
        >
          {error || visionError}
        </Alert>
      )}

      {/* Vision Controls */}
      <Paper sx={{ p: 2, mb: 3, maxWidth: 1200, mx: 'auto' }}>
        <Typography variant="subtitle1" gutterBottom>
          Live Vision
        </Typography>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
          <FormControl size="small" sx={{ minWidth: 200 }}>
            <InputLabel>Webcam</InputLabel>
            <Select
              value={selectedWebcam}
              label="Webcam"
              onChange={(e) => setSelectedWebcam(e.target.value)}
              disabled={visionActive}
            >
              {webcams.map((cam) => (
                <MenuItem key={cam} value={cam}>
                  {cam}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Tooltip title="Refresh webcam list">
            <IconButton onClick={loadWebcams} disabled={visionActive}>
              <RefreshIcon />
            </IconButton>
          </Tooltip>
          <FormControlLabel
            control={<Switch checked={enableFace} onChange={(e) => setEnableFace(e.target.checked)} size="small" />}
            label="Face"
            disabled={visionActive}
          />
          <FormControlLabel
            control={<Switch checked={enablePose} onChange={(e) => setEnablePose(e.target.checked)} size="small" />}
            label="Pose"
            disabled={visionActive}
          />
          <FormControlLabel
            control={<Switch checked={enableHands} onChange={(e) => setEnableHands(e.target.checked)} size="small" />}
            label="Hands"
            disabled={visionActive}
          />
          <Button
            variant={visionActive ? 'outlined' : 'contained'}
            color={visionActive ? 'error' : 'primary'}
            startIcon={visionActive ? <VideocamOffIcon /> : <VideocamIcon />}
            onClick={visionActive ? stopVision : startVision}
            disabled={!selectedWebcam && !visionActive}
          >
            {visionActive ? 'Stop Vision' : 'Start Vision'}
          </Button>
        </Box>

        {visionActive && (
          <Box sx={{ mt: 2 }}>
            <Divider sx={{ mb: 1 }} />

            {/* Live webcam preview with detection overlay */}
            <Box
              sx={{
                mb: 2,
                display: 'flex',
                justifyContent: 'center',
                bgcolor: 'black',
                borderRadius: 2,
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              <video
                ref={visionVideoRef}
                autoPlay
                playsInline
                muted
                style={{ maxWidth: '100%', maxHeight: 400, objectFit: 'contain' }}
              />
              <canvas
                ref={visionCanvasRef}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: '100%',
                  pointerEvents: 'none',
                }}
              />
            </Box>

            {latestResult && (
              <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Detected Faces
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.5 }}>
                    {latestResult.faces.length === 0 ? (
                      <Typography variant="body2" color="text.secondary">
                        None
                      </Typography>
                    ) : (
                      latestResult.faces.map((face, i) => (
                        <Chip
                          key={i}
                          icon={<PersonIcon />}
                          label={`${face.name} (${Math.round(face.confidence * 100)}%)`}
                          size="small"
                          color={face.identity_id ? 'success' : 'default'}
                          variant="outlined"
                        />
                      ))
                    )}
                  </Box>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Detected Gestures
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.5 }}>
                    {latestResult.gestures.length === 0 ? (
                      <Typography variant="body2" color="text.secondary">
                        None
                      </Typography>
                    ) : (
                      latestResult.gestures.map((g, i) => (
                        <Chip
                          key={i}
                          label={`${g.gesture} (${Math.round(g.confidence * 100)}%)`}
                          size="small"
                          color="primary"
                          variant="outlined"
                        />
                      ))
                    )}
                  </Box>
                </Box>
              </Box>
            )}
          </Box>
        )}
      </Paper>

      {/* Faces Grid */}
      {loading ? (
        <Typography sx={{ textAlign: 'center', mt: 4 }}>Loading faces...</Typography>
      ) : faces.length === 0 ? (
        <Paper sx={{ p: 4, textAlign: 'center', maxWidth: 600, mx: 'auto' }}>
          <Typography variant="h6" gutterBottom>
            No faces registered
          </Typography>
          <Typography color="text.secondary" sx={{ mb: 3 }}>
            Register faces to enable recognition during live vision. Use your webcam to scan your
            face from multiple angles.
          </Typography>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setCreateDialogOpen(true)}
          >
            Register Face
          </Button>
        </Paper>
      ) : (
        <Grid container spacing={3} sx={{ maxWidth: 1200, mx: 'auto' }}>
          <AnimatePresence>
            {faces.map((face) => (
              <Grid item xs={12} sm={6} md={4} key={face.id}>
                <MotionCard
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ duration: 0.3 }}
                  onClick={() => handleOpenDetail(face)}
                  sx={{
                    cursor: 'pointer',
                    border: '1px solid',
                    borderColor: 'divider',
                    '&:hover': { boxShadow: 3, transform: 'translateY(-2px)' },
                    transition: 'box-shadow 0.2s, transform 0.2s',
                  }}
                >
                  <CardContent sx={{ textAlign: 'center', pt: 4 }}>
                    <Avatar
                      sx={{
                        width: 80,
                        height: 80,
                        mx: 'auto',
                        mb: 2,
                        bgcolor: 'primary.main',
                        fontSize: '2rem',
                      }}
                    >
                      {face.name[0]?.toUpperCase()}
                    </Avatar>
                    <Typography variant="h6" gutterBottom>
                      {face.name}
                    </Typography>
                    <Chip
                      icon={<PhotoCameraIcon />}
                      label={`${face.photo_count} photo${face.photo_count !== 1 ? 's' : ''}`}
                      size="small"
                      variant="outlined"
                    />
                  </CardContent>
                  <CardActions sx={{ justifyContent: 'center', pb: 2 }}>
                    <Tooltip title="Delete">
                      <IconButton
                        onClick={(e) => {
                          e.stopPropagation();
                          setFaceToDelete(face);
                          setDeleteDialogOpen(true);
                        }}
                        color="error"
                      >
                        <DeleteIcon />
                      </IconButton>
                    </Tooltip>
                  </CardActions>
                </MotionCard>
              </Grid>
            ))}
          </AnimatePresence>
        </Grid>
      )}

      {/* Hidden canvas for detail dialog captures */}
      <canvas ref={webcamCanvasRef} style={{ display: 'none' }} />

      {/* Create Dialog */}
      <FaceCreateDialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        onCreated={(name, photoCount) => {
          setSuccessMessage(`Face "${name}" registered with ${photoCount} photo(s)`);
          loadFaces();
        }}
        onError={(message) => setError(message)}
      />

      {/* Detail Dialog */}
      <Dialog open={detailDialogOpen} onClose={handleCloseDetail} maxWidth="md" fullWidth>
        <DialogTitle>{selectedFace?.name} - Photos</DialogTitle>
        <DialogContent>
          {selectedFace && (
            <Box>
              <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mt: 1 }}>
                {selectedFace.photos.map((photo) => (
                  <Box
                    key={photo.id}
                    sx={{
                      position: 'relative',
                      width: 120,
                      height: 120,
                      borderRadius: 2,
                      overflow: 'hidden',
                      border: '1px solid',
                      borderColor: 'divider',
                    }}
                  >
                    <img
                      src={apiClient.getImageUrl(photo.photo_uuid)}
                      alt="Face photo"
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                    <IconButton
                      size="small"
                      color="error"
                      onClick={() => handleDeletePhoto(photo.id)}
                      sx={{
                        position: 'absolute',
                        top: 2,
                        right: 2,
                        bgcolor: 'rgba(255,255,255,0.8)',
                        '&:hover': { bgcolor: 'rgba(255,255,255,0.95)' },
                      }}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Box>
                ))}
              </Box>

              <Divider sx={{ my: 2 }} />

              {detailScanning ? (
                <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                  <Box
                    sx={{
                      width: '100%',
                      maxWidth: 320,
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
                      onClick={handleDetailCapture}
                      disabled={!webcamStream}
                    >
                      Capture & Add
                    </Button>
                    <Button variant="outlined" onClick={handleDetailStopScan}>
                      Stop Camera
                    </Button>
                  </Box>
                </Box>
              ) : (
                <Button
                  variant="outlined"
                  startIcon={<CameraAltIcon />}
                  onClick={handleDetailStartScan}
                >
                  Scan Face
                </Button>
              )}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseDetail}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Delete Face</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete "{faceToDelete?.name}"? This will remove all associated
            photos. This action cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" color="error" onClick={handleDelete}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};
