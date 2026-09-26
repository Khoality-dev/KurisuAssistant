import { useState, useCallback, useRef, useEffect } from 'react';
import { apiClient, describeSpeechFailure } from '@kurisu/api';
import { storage } from '@kurisu/api';
import { publishSpeech, publishSpeechSync } from '@kurisu/state';
import type { SpeechSegment } from '@kurisu/models';
import type { SegmentCue } from './emotionTiming';
import { curveOfWav, useAudioAmplitude, type AmplitudeCurve, type PlaybackListeners } from './useAudioAmplitude';

/** How long a sentence that could not be synthesized is held, so its subtitle and cues still show (#244). */
export const FAILED_SENTENCE_MS = 4000;

/**
 * One sentence for the character feed: the curve and the moment its audio
 * began, pushed once. Every surface clocks the mouth from this (#238), and
 * shows each of the sentence's feelings when the audio reaches its fraction
 * of the way through (#244) — across the silent hold of a sentence that could
 * not be synthesized too.
 */
export function segmentOf(text: string, curve: AmplitudeCurve | null, startedAt: number, cues: readonly SegmentCue[] = []): SpeechSegment {
  const durationMs = curve?.durationMs ?? FAILED_SENTENCE_MS;
  return {
    text,
    startedAt,
    durationMs,
    windowMs: curve?.windowMs ?? 1000 / 30,
    curve: curve?.values ?? null,
    cues: cues.map((c) => ({ emotion: c.emotion, delayMs: c.atFraction * durationMs })),
  };
}

/** What playback tells the feed. */
function feedListeners(text: string, cues: readonly SegmentCue[] = []): PlaybackListeners {
  return {
    onPlaying: (curve, startedAt) => publishSpeech(segmentOf(text, curve, startedAt, cues)),
    onProgress: (positionMs, at) => publishSpeechSync({ positionMs, at }),
  };
}

export function useTTS(
  onPlaybackStart?: (text: string, duration: number) => void,
  /**
   * A sentence that could not be synthesized or played, as one line for the
   * user. Without it a dead speech service was a console line and silence (#200).
   */
  onError?: (message: string) => void,
) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [voices, setVoices] = useState<string[]>([]);
  // Only what the server actually lists: no invented models. `backendsError`
  // says why the list is empty when it is — the speech service being down
  // used to be papered over by a static list, so the picker offered models
  // that did not exist and synthesis failed later (#151).
  const [backends, setBackends] = useState<string[]>([]);
  const [backendsError, setBackendsError] = useState<string | null>(null);

  const amplitudeController = useAudioAmplitude();
  const playbackStartCallbackRef = useRef(onPlaybackStart);
  playbackStartCallbackRef.current = onPlaybackStart;
  const errorCallbackRef = useRef(onError);
  errorCallbackRef.current = onError;
  const reportFailure = useCallback((what: string, error: unknown) => {
    const cb = errorCallbackRef.current;
    if (!cb) return;
    describeSpeechFailure(what, error).then(cb).catch(() => {});
  }, []);

  // Queue-based streaming TTS state
  const ttsQueueRef = useRef<Array<{ audioPromise: Promise<Blob>; text: string; cues: SegmentCue[] }>>([]);
  const isPlayingQueueRef = useRef(false);
  const [isQueueActive, setIsQueueActive] = useState(false);

  const loadVoices = useCallback(async (backend?: string) => {
    try {
      const voiceList = await apiClient.listVoices(backend);
      setVoices(voiceList);
      return voiceList;
    } catch (error) {
      console.error('Failed to load voices:', error);
      return [];
    }
  }, []);

  const loadBackends = useCallback(async () => {
    try {
      const models = await apiClient.listTTSModels();
      setBackends(models);
      setBackendsError(null);
      return models;
    } catch (error: any) {
      console.error('Failed to load TTS models:', error);
      setBackends([]);
      setBackendsError(error.response?.data?.detail || 'The speech service is unreachable.');
      return [];
    }
  }, []);

  /**
   * Play text as speech (single-shot, e.g. from MessageBubble play button).
   * The character hears it like any sentence: the curve goes out on `playing`.
   */
  const speak = useCallback(
    async (
      text: string,
      voice?: string,
      language?: string,
      backend?: string,
    ) => {
      try {
        setIsPlaying(true);
        const audioBlob = await apiClient.synthesize(text, voice, language, backend);
        try {
          await amplitudeController.playWithAmplitude(audioBlob, feedListeners(text));
        } finally {
          publishSpeech(null);
          setIsPlaying(false);
        }
      } catch (error) {
        setIsPlaying(false);
        console.error('TTS error:', error);
        reportFailure('Speech', error);
        throw error;
      }
    },
    [amplitudeController, reportFailure]
  );

  /**
   * Sequential playback loop — plays queued audio blobs in FIFO order. The
   * feed's segment stays up across sentences and is dropped once at the end,
   * so the mouth does not snap shut between them.
   */
  const playQueue = useCallback(async () => {
    isPlayingQueueRef.current = true;

    while (ttsQueueRef.current.length > 0) {
      const item = ttsQueueRef.current.shift()!;
      try {
        const blob = await item.audioPromise;
        const curve = await curveOfWav(blob);
        // Notify subtitle system with text + audio duration before playback
        const psCb = playbackStartCallbackRef.current;
        if (psCb && curve) psCb(item.text, curve.durationMs / 1000);
        await amplitudeController.playWithAmplitude(blob, feedListeners(item.text, item.cues), curve);
      } catch (e) {
        console.error('TTS queue playback error:', e);
        reportFailure('Speech', e);
        // TTS failed — still send subtitle with 4s fallback duration, and hold
        // a silent segment for as long, so a cue on it still lands (#244).
        const psCb = playbackStartCallbackRef.current;
        if (psCb) psCb(item.text, FAILED_SENTENCE_MS / 1000);
        publishSpeech(segmentOf(item.text, null, Date.now(), item.cues));
      }
    }

    // Signal done
    publishSpeech(null);
    isPlayingQueueRef.current = false;
    setIsQueueActive(false);
  }, [amplitudeController, reportFailure]);

  /**
   * Queue text for synthesis and sequential playback (used during streaming),
   * with the feelings that ride it (#244).
   */
  const queueText = useCallback((text: string, voice?: string, cues: SegmentCue[] = []) => {
    if (!text.trim()) return;

    // No stored choice means no `provider` on the request, so the server's
    // default TTS model answers; the client does not guess one (#200).
    const backend = storage.getTTSBackend() || undefined;

    const trimmed = text.trim();
    const audioPromise = apiClient.synthesize(trimmed, voice, undefined, backend);
    ttsQueueRef.current.push({ audioPromise, text: trimmed, cues });
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
    amplitudeController.stop();
    publishSpeech(null);
    isPlayingQueueRef.current = false;
    setIsQueueActive(false);
  }, [amplitudeController]);

  /**
   * Stop current single-shot speech.
   */
  const stop = useCallback(() => {
    amplitudeController.stop();
    publishSpeech(null);
    setIsPlaying(false);
  }, [amplitudeController]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      ttsQueueRef.current = [];
      isPlayingQueueRef.current = false;
      publishSpeech(null);
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
    backendsError,
    loadBackends,
  };
}
