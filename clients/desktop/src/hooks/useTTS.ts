import { useState, useCallback, useRef, useEffect } from 'react';
import { apiClient } from '../api/client';
import { storage } from '../utils/storage';

export function useTTS() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [voices, setVoices] = useState<string[]>([]);
  const [backends, setBackends] = useState<string[]>([]);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  // Queue-based streaming TTS state
  const ttsQueueRef = useRef<Array<{ audioPromise: Promise<Blob> }>>([]);
  const isPlayingQueueRef = useRef(false);
  const currentQueueAudioRef = useRef<HTMLAudioElement | null>(null);
  const [isQueueActive, setIsQueueActive] = useState(false);

  /**
   * Load available voices
   */
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

  /**
   * Load available backends
   */
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
   * Play text as speech
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

        // Revoke previous object URL if exists
        if (audioUrlRef.current) {
          URL.revokeObjectURL(audioUrlRef.current);
          audioUrlRef.current = null;
        }

        setIsPlaying(true);

        // Synthesize speech
        const audioBlob = await apiClient.synthesize(text, voice, language, backend, emotionParams, apiUrl);

        // Create audio element
        const audioUrl = URL.createObjectURL(audioBlob);
        audioUrlRef.current = audioUrl;
        const audio = new Audio(audioUrl);

        // Set up event listeners
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

        // Play audio
        currentAudioRef.current = audio;
        await audio.play();
      } catch (error) {
        setIsPlaying(false);
        console.error('TTS error:', error);
        throw error;
      }
    },
    []
  );

  /**
   * Play a single audio blob, resolves when playback finishes
   */
  const playBlobAsync = useCallback((blob: Blob): Promise<void> => {
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
  }, []);

  /**
   * Sequential playback loop — plays queued audio blobs in FIFO order
   */
  const playQueue = useCallback(async () => {
    isPlayingQueueRef.current = true;
    while (ttsQueueRef.current.length > 0) {
      const item = ttsQueueRef.current.shift()!;
      try {
        const blob = await item.audioPromise;
        await playBlobAsync(blob);
      } catch (e) {
        console.error('TTS queue playback error:', e);
      }
    }
    isPlayingQueueRef.current = false;
    setIsQueueActive(false);
  }, [playBlobAsync]);

  /**
   * Queue text for synthesis and sequential playback (used during streaming).
   * Synthesis starts immediately; playback is sequential in FIFO order.
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

    // Start synthesis immediately (don't wait for previous)
    const audioPromise = apiClient.synthesize(text.trim(), voice, undefined, backend, emotionParams, apiUrl);
    ttsQueueRef.current.push({ audioPromise });
    setIsQueueActive(true);

    // Start playback loop if not already running
    if (!isPlayingQueueRef.current) {
      playQueue();
    }
  }, [playQueue]);

  /**
   * Cancel all queued TTS synthesis and stop current playback
   */
  const clearQueue = useCallback(() => {
    ttsQueueRef.current = [];
    if (currentQueueAudioRef.current) {
      currentQueueAudioRef.current.pause();
      currentQueueAudioRef.current = null;
    }
    isPlayingQueueRef.current = false;
    setIsQueueActive(false);
  }, []);

  /**
   * Stop current speech
   */
  const stop = useCallback(() => {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current.currentTime = 0;
      setIsPlaying(false);
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (currentAudioRef.current) {
        currentAudioRef.current.pause();
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
      }
      // Clean up queue audio
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
