import { create } from 'zustand';
import { MicVAD } from '@ricky0123/vad-web';
import { apiClient } from '../api/client';
import { storage } from '../utils/storage';
import { useAgentStore } from './agentStore';

export type ASRStatus = 'idle' | 'listening' | 'processing';

export interface AudioDevice {
  deviceId: string;
  label: string;
}

export interface ASRResult {
  text: string;
  seq: number;
}

interface MicState {
  // ASR state
  status: ASRStatus;
  result: ASRResult | null;
  error: string | null;

  // Device management
  devices: AudioDevice[];
  selectedDeviceId: string | null;

  // Interactive mode (call bar UI) + interaction active (auto-send without trigger word)
  interactiveMode: boolean;
  interactionActive: boolean;

  // Actions
  startListening: () => Promise<void>;
  stopListening: () => Promise<void>;
  loadDevices: () => Promise<AudioDevice[]>;
  selectDevice: (deviceId: string) => void;
  enableInteractiveMode: () => void;
  disableInteractiveMode: () => void;
  activateInteraction: () => void;
  deactivateInteraction: () => void;
}

// Module-level VAD state (not in Zustand to avoid re-renders)
let _vad: MicVAD | null = null;
let _seq = 0;

// Reusable audio elements for sound effects (avoids WebMediaPlayer leak)
let _startSound: HTMLAudioElement | null = null;
let _stopSound: HTMLAudioElement | null = null;

function playStartSound() {
  if (!_startSound) _startSound = new Audio('/start_effect.wav');
  _startSound.currentTime = 0;
  _startSound.play().catch(() => {});
}

function playStopSound() {
  if (!_stopSound) _stopSound = new Audio('/stop_effect.wav');
  _stopSound.currentTime = 0;
  _stopSound.play().catch(() => {});
}

export const useMicStore = create<MicState>((set, get) => ({
  status: 'idle',
  result: null,
  error: null,
  devices: [],
  selectedDeviceId: storage.getASRDeviceId(),
  interactiveMode: false,
  interactionActive: false,

  startListening: async () => {
    // Guard: skip if already listening or initializing
    if (_vad) return;

    set({ error: null });
    const deviceId = get().selectedDeviceId || undefined;

    try {
      const vad = await MicVAD.new({
        baseAssetPath: './vad/',
        onnxWASMBasePath: './vad/',
        model: 'legacy',
        startOnLoad: true,
        getStream: async () =>
          navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: deviceId ? { exact: deviceId } : undefined,
              channelCount: 1,
              echoCancellation: true,
              autoGainControl: true,
              noiseSuppression: true,
            },
          }),
        onSpeechEnd: async (audio: Float32Array) => {
          // Skip audio too short to contain a trigger word (< 0.5s at 16kHz)
          if (audio.length < 8000) return;

          const int16 = new Int16Array(audio.length);
          for (let i = 0; i < audio.length; i++) {
            const s = Math.max(-1, Math.min(1, audio[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }

          set({ status: 'processing' });

          try {
            const asrMode = storage.getASRMode();
            const { interactiveMode, interactionActive } = get();
            const mode = interactiveMode && !interactionActive ? 'fast' : undefined;

            let language: string | undefined;
            let model: string | undefined;

            if (asrMode === 'routing') {
              // Only detect among languages that have a model mapping
              const modelMap = storage.getASRModelMap();
              const mappedLanguages = modelMap
                .map((e) => e.language)
                .filter((l) => !!l);
              const detected = await apiClient.detectLanguage(
                int16.buffer,
                mappedLanguages.length > 0 ? { languages: mappedLanguages } : undefined,
              );
              language = detected.language || undefined;
              model = language ? storage.getASRModelForLanguage(language) : undefined;
            } else {
              const fixedModel = storage.getASRFixedModel();
              if (fixedModel) model = fixedModel;
            }

            // Pass selected persona's trigger word to bias recognition
            const { agents, selectedAgentId } = useAgentStore.getState();
            const selectedAgent = agents.find((a) => a.id === selectedAgentId);
            const triggerWord = selectedAgent?.persona?.trigger_word?.trim();
            const initial_prompt = triggerWord || undefined;

            const response = await apiClient.transcribe(int16.buffer, { language, mode, model, initial_prompt });

            if (response.text.trim()) {
              _seq += 1;
              set({ result: { text: response.text.trim(), seq: _seq } });
            }
          } catch (err: any) {
            console.error('ASR transcription error:', err);
            set({ error: err.message || 'Transcription failed' });
          }

          if (get().status !== 'idle') {
            set({ status: 'listening' });
          }
        },
      });

      _vad = vad;
      set({ status: 'listening' });
    } catch (err: any) {
      console.error('Failed to start VAD:', err);
      set({ error: err.message || 'Failed to access microphone', status: 'idle' });
    }
  },

  stopListening: async () => {
    if (_vad) {
      await _vad.destroy();
      _vad = null;
    }
    set({ status: 'idle' });
  },

  loadDevices: async () => {
    try {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch (_) {
        // Permission may already be granted or denied
      }
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = allDevices
        .filter((d) => d.kind === 'audioinput')
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${d.deviceId.slice(0, 8)}`,
        }));
      set({ devices: audioInputs });
      return audioInputs;
    } catch (err) {
      console.error('Failed to enumerate audio devices:', err);
      return [];
    }
  },

  selectDevice: (deviceId: string) => {
    set({ selectedDeviceId: deviceId });
    storage.setASRDeviceId(deviceId);
  },

  enableInteractiveMode: () => {
    if (get().interactiveMode) return;
    set({ interactiveMode: true });
    if (get().status === 'idle') {
      get().startListening();
    }
  },

  disableInteractiveMode: () => {
    if (!get().interactiveMode) return;
    set({ interactiveMode: false, interactionActive: false });
    if (get().status !== 'idle') {
      get().stopListening();
    }
  },

  activateInteraction: () => {
    if (get().interactionActive) return;
    set({ interactionActive: true });
    playStartSound();
  },

  deactivateInteraction: () => {
    if (!get().interactionActive) return;
    set({ interactionActive: false });
    playStopSound();
  },
}));
