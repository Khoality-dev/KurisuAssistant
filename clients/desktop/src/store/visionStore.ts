import { create } from 'zustand';
import { wsManager, VisionResultEvent } from '../api/websocket';
import type { VisionResult } from '../api/types';

const DEFAULT_RTSP_URL = 'rtsp://localhost:8554/webcam';

interface VisionState {
  isActive: boolean;
  latestResult: VisionResult | null;
  webcams: string[];
  selectedWebcam: string;
  enableFace: boolean;
  enablePose: boolean;
  enableHands: boolean;
  error: string;

  loadWebcams: () => Promise<void>;
  startVision: () => Promise<void>;
  stopVision: () => Promise<void>;
  setSelectedWebcam: (webcam: string) => void;
  setEnableFace: (enabled: boolean) => void;
  setEnablePose: (enabled: boolean) => void;
  setEnableHands: (enabled: boolean) => void;
}

let _active = false;

export const useVisionStore = create<VisionState>((set, get) => ({
  isActive: false,
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
    if (_active) return;
    set({ error: '' });

    const { selectedWebcam, enableFace, enablePose, enableHands } = get();

    const api = window.electron?.vision;
    if (!api) {
      set({ error: 'Vision API not available (requires Electron)' });
      return;
    }

    if (!selectedWebcam) {
      set({ error: 'No webcam selected' });
      return;
    }

    try {
      const rtspUrl = DEFAULT_RTSP_URL;
      await api.start(selectedWebcam, rtspUrl);
      await wsManager.sendVisionStart(rtspUrl, {
        enable_face: enableFace,
        enable_pose: enablePose,
        enable_hands: enableHands,
      });
      _active = true;
      set({ isActive: true });
    } catch (err: any) {
      set({ error: `Failed to start vision: ${err.message}` });
    }
  },

  stopVision: async () => {
    if (!_active) return;

    try {
      wsManager.sendVisionStop();
      const api = window.electron?.vision;
      if (api) {
        await api.stop();
      }
    } catch (err: any) {
      console.error('Failed to stop vision:', err);
    } finally {
      _active = false;
      set({ isActive: false, latestResult: null });
    }
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
      debug_frame: event.debug_frame,
    },
  });

  // Forward gestures to character window via IPC
  if (event.gestures.length > 0) {
    const gestureNames = event.gestures.map((g) => g.gesture);
    window.electron?.characterWindow?.sendGestureUpdate({ gestures: gestureNames });
  }
});
