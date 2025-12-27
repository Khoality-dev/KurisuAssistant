import { useState, useCallback, useRef, useEffect } from 'react';
import { apiClient } from '../api/client';

export function useTTS() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [voices, setVoices] = useState<string[]>([]);
  const [backends, setBackends] = useState<string[]>([]);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

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
      }
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
        const audioBlob = await apiClient.synthesize(text, voice, language, backend, emotionParams);

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
    };
  }, []);

  return {
    speak,
    stop,
    isPlaying,
    voices,
    loadVoices,
    backends,
    loadBackends,
  };
}
