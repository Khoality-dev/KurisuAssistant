import { useState, useCallback, useRef, useEffect } from 'react';
import { MicVAD } from '@ricky0123/vad-web';
import { apiClient } from '../api/client';
import { storage } from '../utils/storage';

export type ASRStatus = 'idle' | 'listening' | 'processing';

export interface AudioDevice {
  deviceId: string;
  label: string;
}

export function useASR() {
  const [status, setStatus] = useState<ASRStatus>('idle');
  const [transcript, setTranscript] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(
    storage.getASRDeviceId()
  );
  const vadRef = useRef<MicVAD | null>(null);
  const statusRef = useRef<ASRStatus>('idle');

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const loadDevices = useCallback(async () => {
    try {
      // Request permission first if needed (to get device labels)
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch (_) {
        // Permission may already be granted or denied — enumerate anyway
      }
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = allDevices
        .filter((d) => d.kind === 'audioinput')
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${d.deviceId.slice(0, 8)}`,
        }));
      console.log('[useASR] Audio input devices:', audioInputs);
      setDevices(audioInputs);
      return audioInputs;
    } catch (err) {
      console.error('Failed to enumerate audio devices:', err);
      return [];
    }
  }, []);

  const selectDevice = useCallback((deviceId: string) => {
    setSelectedDeviceId(deviceId);
    storage.setASRDeviceId(deviceId);
  }, []);

  const startListening = useCallback(async () => {
    setError(null);
    setTranscript('');

    const deviceId = selectedDeviceId || undefined;

    try {
      const vad = await MicVAD.new({
        baseAssetPath: '/vad/',
        onnxWASMBasePath: '/vad/',
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
          const int16 = new Int16Array(audio.length);
          for (let i = 0; i < audio.length; i++) {
            const s = Math.max(-1, Math.min(1, audio[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }

          setStatus('processing');

          try {
            const text = await apiClient.transcribe(int16.buffer);
            if (text.trim()) {
              setTranscript(text.trim());
            }
          } catch (err: any) {
            console.error('ASR transcription error:', err);
            setError(err.message || 'Transcription failed');
          }

          if (statusRef.current !== 'idle') {
            setStatus('listening');
          }
        },
      });

      vadRef.current = vad;
      setStatus('listening');
    } catch (err: any) {
      console.error('Failed to start VAD:', err);
      setError(err.message || 'Failed to access microphone');
      setStatus('idle');
    }
  }, [selectedDeviceId]);

  const stopListening = useCallback(async () => {
    if (vadRef.current) {
      await vadRef.current.destroy();
      vadRef.current = null;
    }
    setStatus('idle');
  }, []);

  useEffect(() => {
    return () => {
      if (vadRef.current) {
        vadRef.current.destroy();
        vadRef.current = null;
      }
    };
  }, []);

  return {
    startListening,
    stopListening,
    status,
    transcript,
    error,
    devices,
    loadDevices,
    selectedDeviceId,
    selectDevice,
  };
}
