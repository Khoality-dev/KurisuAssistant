import { useState, useCallback, useRef, useEffect } from 'react';
import { apiClient } from '../api/client';
import { storage } from '../utils/storage';
import { useAudioAmplitude } from './useAudioAmplitude';

/**
 * @param onAmplitudeUpdate - Optional callback invoked at ~30fps with amplitude (0-1)
 *   when character panel is active. If not provided, uses plain Audio playback.
 */
export function useTTS(onAmplitudeUpdate?: (amplitude: number, isPlaying: boolean) => void) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [voices, setVoices] = useState<string[]>([]);
  const [backends, setBackends] = useState<string[]>([]);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  const amplitudeController = useAudioAmplitude();
  const amplitudeCallbackRef = useRef(onAmplitudeUpdate);
  amplitudeCallbackRef.current = onAmplitudeUpdate;

  // Queue-based streaming TTS state
  const ttsQueueRef = useRef<Array<{ audioPromise: Promise<Blob> }>>([]);
  const isPlayingQueueRef = useRef(false);
  const currentQueueAudioRef = useRef<HTMLAudioElement | null>(null);
  const [isQueueActive, setIsQueueActive] = useState(false);

  const loadVoices = useCallback(async () => {
    try {
      const voiceList = await apiClient.listVoices();
      setVoices(voiceList);
      return voiceList;
    } catch (error) {
      console.error('Failed to load voices:', error);
      return [];
    }
  }, []);

  const loadBackends = useCallback(async () => {
    try {
      const backendList = await apiClient.listBackends();
      setBackends(backendList);
      return backendList;
    } catch (error) {
      console.error('Failed to load backends:', error);
      return [];
    }
  }, []);

  /**
   * Play text as speech (single-shot, e.g. from MessageBubble play button).
   */
  const speak = useCallback(
    async (
      text: string,
      voice?: string,
      language?: string,
      backend?: string,
      emotionParams?: {
        emo_audio?: string;
        emo_alpha?: number;
        use_emo_text?: boolean;
      },
      apiUrl?: string,
    ) => {
      try {
        // Stop current audio if playing
        if (currentAudioRef.current) {
          currentAudioRef.current.pause();
          currentAudioRef.current.currentTime = 0;
        }
        if (audioUrlRef.current) {
          URL.revokeObjectURL(audioUrlRef.current);
          audioUrlRef.current = null;
        }

        setIsPlaying(true);

        const audioBlob = await apiClient.synthesize(text, voice, language, backend, emotionParams, apiUrl);

        // Use amplitude path for lip sync if callback is set
        if (amplitudeCallbackRef.current) {
          const cb = amplitudeCallbackRef.current;
          try {
            await amplitudeController.playWithAmplitude(audioBlob, cb);
          } finally {
            setIsPlaying(false);
          }
          return;
        }

        // Plain audio path (no character panel)
        const audioUrl = URL.createObjectURL(audioBlob);
        audioUrlRef.current = audioUrl;
        const audio = new Audio(audioUrl);

        audio.onended = () => {
          setIsPlaying(false);
          if (audioUrlRef.current) {
            URL.revokeObjectURL(audioUrlRef.current);
            audioUrlRef.current = null;
          }
        };

        audio.onerror = () => {
          setIsPlaying(false);
          console.error('Audio playback error');
          if (audioUrlRef.current) {
            URL.revokeObjectURL(audioUrlRef.current);
            audioUrlRef.current = null;
          }
        };

        currentAudioRef.current = audio;
        await audio.play();
      } catch (error) {
        setIsPlaying(false);
        console.error('TTS error:', error);
        throw error;
      }
    },
    [amplitudeController]
  );

  /**
   * Play a single audio blob. Uses amplitude path if callback is set.
   * The onAmplitude callback is kept alive across blobs in a queue
   * by passing a wrapper that always calls `true` for isPlaying,
   * so the mouth doesn't snap shut between sentences.
   */
  const playBlobAsync = useCallback((blob: Blob, onAmplitude?: (amp: number, playing: boolean) => void): Promise<void> => {
    if (onAmplitude) {
      // Wrap: always report playing=true (queue manages the final false)
      return amplitudeController.playWithAmplitude(blob, (amp) => onAmplitude(amp, true));
    }

    // Plain audio path
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentQueueAudioRef.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        currentQueueAudioRef.current = null;
        resolve();
      };
      audio.onerror = (e) => {
        URL.revokeObjectURL(url);
        currentQueueAudioRef.current = null;
        reject(e);
      };
      audio.play().catch(reject);
    });
  }, [amplitudeController]);

  /**
   * Sequential playback loop — plays queued audio blobs in FIFO order.
   */
  const playQueue = useCallback(async () => {
    isPlayingQueueRef.current = true;
    const cb = amplitudeCallbackRef.current;

    while (ttsQueueRef.current.length > 0) {
      const item = ttsQueueRef.current.shift()!;
      try {
        const blob = await item.audioPromise;
        await playBlobAsync(blob, cb || undefined);
      } catch (e) {
        console.error('TTS queue playback error:', e);
      }
    }

    // Signal done
    if (cb) cb(0, false);
    isPlayingQueueRef.current = false;
    setIsQueueActive(false);
  }, [playBlobAsync]);

  /**
   * Queue text for synthesis and sequential playback (used during streaming).
   */
  const queueText = useCallback((text: string, voice?: string) => {
    if (!text.trim()) return;

    const backend = storage.getTTSBackend() || 'gpt-sovits';
    const apiUrl = storage.getGPTSoVITSUrl() || undefined;
    const emotionParams = backend === 'index-tts'
      ? {
          emo_audio: storage.getTTSEmotionAudio() || undefined,
          emo_alpha: storage.getTTSEmotionAlpha(),
          use_emo_text: storage.getTTSUseEmotionText(),
        }
      : undefined;

    const audioPromise = apiClient.synthesize(text.trim(), voice, undefined, backend, emotionParams, apiUrl);
    ttsQueueRef.current.push({ audioPromise });
    setIsQueueActive(true);

    if (!isPlayingQueueRef.current) {
      playQueue();
    }
  }, [playQueue]);

  /**
   * Cancel all queued TTS and stop current playback.
   */
  const clearQueue = useCallback(() => {
    ttsQueueRef.current = [];
    if (currentQueueAudioRef.current) {
      currentQueueAudioRef.current.pause();
      currentQueueAudioRef.current = null;
    }
    amplitudeController.stop();
    const cb = amplitudeCallbackRef.current;
    if (cb) cb(0, false);
    isPlayingQueueRef.current = false;
    setIsQueueActive(false);
  }, [amplitudeController]);

  /**
   * Stop current single-shot speech.
   */
  const stop = useCallback(() => {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current.currentTime = 0;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    amplitudeController.stop();
    const cb = amplitudeCallbackRef.current;
    if (cb) cb(0, false);
    setIsPlaying(false);
  }, [amplitudeController]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (currentAudioRef.current) {
        currentAudioRef.current.pause();
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
      }
      if (currentQueueAudioRef.current) {
        currentQueueAudioRef.current.pause();
      }
      ttsQueueRef.current = [];
      isPlayingQueueRef.current = false;
    };
  }, []);

  return {
    speak,
    stop,
    isPlaying,
    queueText,
    clearQueue,
    isQueueActive,
    voices,
    loadVoices,
    backends,
    loadBackends,
  };
}
