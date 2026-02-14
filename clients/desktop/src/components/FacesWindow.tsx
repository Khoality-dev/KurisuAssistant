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
  TextField,
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
  Close as CloseIcon,
} from '@mui/icons-material';
import { motion, AnimatePresence } from 'framer-motion';
import { apiClient } from '../api/client';
import { useVisionStore } from '../store/visionStore';
import type { FaceIdentity, FaceIdentityDetail } from '../api/types';

const MotionCard = motion(Card);

interface CapturedPhoto {
  file: File;
  preview: string;
}

export const FacesWindow: React.FC = () => {
  const [faces, setFaces] = useState<FaceIdentity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  // Create dialog
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [capturedPhotos, setCapturedPhotos] = useState<CapturedPhoto[]>([]);
  const [scanning, setScanning] = useState(false);
  const [creating, setCreating] = useState(false);

  // Webcam (face registration scanning)
  const [webcamStream, setWebcamStream] = useState<MediaStream | null>(null);
  const webcamVideoRef = useRef<HTMLVideoElement>(null);
  const webcamCanvasRef = useRef<HTMLCanvasElement>(null);

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
    const h = canvas.height;

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

  const startWebcam = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
      setWebcamStream(stream);
    } catch (err) {
      setError('Failed to access webcam. Check permissions.');
    }
  }, []);

  const stopWebcam = useCallback(() => {
    if (webcamStream) {
      webcamStream.getTracks().forEach((t) => t.stop());
      setWebcamStream(null);
    }
  }, [webcamStream]);

  // Attach stream to video element
  useEffect(() => {
    if (webcamVideoRef.current && webcamStream) {
      webcamVideoRef.current.srcObject = webcamStream;
    }
  }, [webcamStream, scanning, detailScanning]);

  const captureFrame = useCallback((): CapturedPhoto | null => {
    const video = webcamVideoRef.current;
    const canvas = webcamCanvasRef.current;
    if (!video || !canvas || video.readyState < 2) return null;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    const arr = dataUrl.split(',');
    const mime = arr[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
    const bstr = atob(arr[1]);
    const u8arr = new Uint8Array(bstr.length);
    for (let i = 0; i < bstr.length; i++) u8arr[i] = bstr.charCodeAt(i);
    const file = new File([u8arr], `capture_${Date.now()}.jpg`, { type: mime });
    return { file, preview: dataUrl };
  }, []);

  // Create dialog: start/stop scanning
  const handleStartScan = useCallback(() => {
    setScanning(true);
    startWebcam();
  }, [startWebcam]);

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

  const handleCloseCreate = useCallback(() => {
    setCreateDialogOpen(false);
    setScanning(false);
    stopWebcam();
    setNewName('');
    setCapturedPhotos([]);
  }, [stopWebcam]);

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
      setSuccessMessage(`Face "${newName}" registered with ${capturedPhotos.length} photo(s)`);
      handleCloseCreate();
      loadFaces();
    } catch (err: any) {
      const detail = err.response?.data?.detail || err.message;
      setError(`Failed to register face: ${detail}`);
    } finally {
      setCreating(false);
    }
  };

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

  const handleDetailStartScan = useCallback(() => {
    setDetailScanning(true);
    startWebcam();
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
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <Paper
        elevation={0}
        sx={{
          p: 2,
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
          onClick={() => {
            setNewName('');
            setCapturedPhotos([]);
            setCreateDialogOpen(true);
          }}
        >
          Register Face
        </Button>
      </Paper>

      {/* Content */}
      <Box sx={{ flex: 1, overflow: 'auto', p: 3, backgroundColor: '#F7F7F8' }}>
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
              onClick={() => {
                setNewName('');
                setCapturedPhotos([]);
                setCreateDialogOpen(true);
              }}
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
      </Box>

      {/* Hidden canvas for captures */}
      <canvas ref={webcamCanvasRef} style={{ display: 'none' }} />

      {/* Create Dialog */}
      <Dialog open={createDialogOpen} onClose={handleCloseCreate} maxWidth="sm" fullWidth>
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
          <Button onClick={handleCloseCreate}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleCreate}
            disabled={!newName.trim() || capturedPhotos.length === 0 || creating}
          >
            {creating ? 'Registering...' : `Register (${capturedPhotos.length} photo${capturedPhotos.length !== 1 ? 's' : ''})`}
          </Button>
        </DialogActions>
      </Dialog>

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
