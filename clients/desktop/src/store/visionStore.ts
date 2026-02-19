import { create } from 'zustand';
import { wsManager, VisionResultEvent, ConnectedEvent } from '../api/websocket';
import type { VisionResult } from '../api/types';

const DETECT_FPS = 5;
const DETECT_INTERVAL = 1000 / DETECT_FPS;

interface VisionState {
  isActive: boolean;
  stream: MediaStream | null;
  latestResult: VisionResult | null;
  webcams: string[];
  selectedWebcam: string;
  enableFace: boolean;
  enablePose: boolean;
  enableHands: boolean;
  error: string;

  loadWebcams: () => Promise<void>;
  startVision: () => Promise<void>;
  stopVision: () => void;
  setSelectedWebcam: (webcam: string) => void;
  setEnableFace: (enabled: boolean) => void;
  setEnablePose: (enabled: boolean) => void;
  setEnableHands: (enabled: boolean) => void;
}

// Module-level state for frame capture (not in Zustand to avoid re-renders)
let _captureInterval: ReturnType<typeof setInterval> | null = null;
let _hiddenVideo: HTMLVideoElement | null = null;
let _hiddenCanvas: HTMLCanvasElement | null = null;

function _stopCapture() {
  if (_captureInterval) {
    clearInterval(_captureInterval);
    _captureInterval = null;
  }
  if (_hiddenVideo) {
    _hiddenVideo.srcObject = null;
    _hiddenVideo.remove();
    _hiddenVideo = null;
  }
  if (_hiddenCanvas) {
    _hiddenCanvas.remove();
    _hiddenCanvas = null;
  }
}

function _startCapture(stream: MediaStream) {
  _stopCapture();

  _hiddenVideo = document.createElement('video');
  _hiddenVideo.srcObject = stream;
  _hiddenVideo.muted = true;
  _hiddenVideo.playsInline = true;
  _hiddenVideo.play();

  _hiddenCanvas = document.createElement('canvas');

  _captureInterval = setInterval(() => {
    if (!_hiddenVideo || !_hiddenCanvas || _hiddenVideo.readyState < 2) return;

    _hiddenCanvas.width = _hiddenVideo.videoWidth;
    _hiddenCanvas.height = _hiddenVideo.videoHeight;
    const ctx = _hiddenCanvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(_hiddenVideo, 0, 0);
    const dataUrl = _hiddenCanvas.toDataURL('image/jpeg', 0.7);
    const base64 = dataUrl.split(',')[1];
    wsManager.sendVisionFrame(base64);
  }, DETECT_INTERVAL);
}

export const useVisionStore = create<VisionState>((set, get) => ({
  isActive: false,
  stream: null,
  latestResult: null,
  webcams: [],
  selectedWebcam: '',
  enableFace: true,
  enablePose: true,
  enableHands: true,
  error: '',

  loadWebcams: async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter((d) => d.kind === 'videoinput');
      const names = videoDevices.map((d) => d.label || `Camera ${d.deviceId.slice(0, 8)}`);
      set({ webcams: names });
      if (names.length > 0 && !get().selectedWebcam) {
        set({ selectedWebcam: names[0] });
      }
    } catch (err: any) {
      set({ error: `Failed to list webcams: ${err.message}` });
    }
  },

  startVision: async () => {
    if (get().isActive) return;
    set({ error: '' });

    const { selectedWebcam, enableFace, enablePose, enableHands } = get();

    if (!selectedWebcam) {
      set({ error: 'No webcam selected' });
      return;
    }

    try {
      // Find deviceId matching the selected webcam label
      const devices = await navigator.mediaDevices.enumerateDevices();
      const match = devices.find(
        (d) => d.kind === 'videoinput' && (d.label === selectedWebcam || d.label.startsWith(selectedWebcam))
      );

      const constraints: MediaStreamConstraints = {
        video: {
          width: 640,
          height: 480,
          ...(match?.deviceId ? { deviceId: { exact: match.deviceId } } : {}),
        },
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);

      // Tell backend to start processing
      await wsManager.sendVisionStart({
        enable_face: enableFace,
        enable_pose: enablePose,
        enable_hands: enableHands,
      });

      // Start frame capture interval
      _startCapture(stream);

      set({ isActive: true, stream });
    } catch (err: any) {
      set({ error: `Failed to start vision: ${err.message}` });
    }
  },

  stopVision: () => {
    const { stream } = get();

    _stopCapture();
    wsManager.sendVisionStop();

    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }

    set({ isActive: false, stream: null, latestResult: null });
  },

  setSelectedWebcam: (webcam: string) => set({ selectedWebcam: webcam }),
  setEnableFace: (enabled: boolean) => set({ enableFace: enabled }),
  setEnablePose: (enabled: boolean) => set({ enablePose: enabled }),
  setEnableHands: (enabled: boolean) => set({ enableHands: enabled }),
}));

// Module-level WebSocket listener — singleton, runs for app lifetime
wsManager.on('vision_result', (event: VisionResultEvent) => {
  if (event.faces.length > 0) {
    console.log('[vision] faces:', event.faces.map((f) => `${f.name} (${Math.round(f.confidence * 100)}%)`).join(', '));
  }
  if (event.gestures.length > 0) {
    console.log('[vision] gestures:', event.gestures.map((g) => `${g.gesture} (${Math.round(g.confidence * 100)}%)`).join(', '));
  }

  useVisionStore.setState({
    latestResult: {
      faces: event.faces,
      gestures: event.gestures,
    },
  });

  // Forward gestures to character window via IPC
  if (event.gestures.length > 0) {
    const gestureNames = event.gestures.map((g) => g.gesture);
    window.electron?.characterWindow?.sendGestureUpdate({ gestures: gestureNames });
  }

  // Forward detected face names to character window via IPC
  const faceNames = event.faces.filter((f) => f.name).map((f) => f.name);
  window.electron?.characterWindow?.sendFaceUpdate({ faces: faceNames });
});

// Sync vision state on WebSocket reconnect
wsManager.on<ConnectedEvent>('connected', (event) => {
  const { isActive } = useVisionStore.getState();

  if (event.vision_active && !isActive) {
    // Server has vision running but client doesn't — tell server to stop
    wsManager.sendVisionStop();
  } else if (!event.vision_active && isActive) {
    // Client has vision active but server lost state (e.g. restart) — re-send vision_start
    const { enableFace, enablePose, enableHands } = useVisionStore.getState();
    wsManager.sendVisionStart({
      enable_face: enableFace,
      enable_pose: enablePose,
      enable_hands: enableHands,
    }).catch(console.error);
  }
  // If both agree (both active or both inactive), do nothing
});
