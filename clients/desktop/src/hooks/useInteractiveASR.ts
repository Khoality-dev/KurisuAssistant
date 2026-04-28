import { useState, useEffect, useRef } from 'react';
import { useMicStore } from '../store/micStore';

interface UseInteractiveASRParams {
  agentId: number | null;
  currentConversationId: number | null;
  isStreaming: boolean;
  isQueueActive: boolean;
  handleSendText: (text: string) => Promise<void>;
  pushExternalDraft: (text: string) => void;
  stopTTSPlayback: () => void;
}

export function useInteractiveASR({
  agentId,
  currentConversationId,
  isStreaming,
  isQueueActive,
  handleSendText,
  pushExternalDraft,
  stopTTSPlayback,
}: UseInteractiveASRParams) {
  const {
    status: asrStatus, result: asrResult,
    interactionActive, deactivateInteraction,
    pttActive,
  } = useMicStore();
  const interactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const INTERACTION_IDLE_MS = 30_000;
  const RESUME_DELAY_MS = 10000;
  const [lastTranscript, setLastTranscript] = useState('');
  const lastTranscriptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track whether VAD is paused by us
  const vadPausedRef = useRef(false);

  const pauseVAD = () => {
    if (resumeTimerRef.current) { clearTimeout(resumeTimerRef.current); resumeTimerRef.current = null; }
    if (!vadPausedRef.current) {
      useMicStore.getState().pauseListening();
      vadPausedRef.current = true;
    }
  };

  const resumeVADDelayed = () => {
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = setTimeout(() => {
      useMicStore.getState().resumeListening();
      vadPausedRef.current = false;
      resumeTimerRef.current = null;
    }, RESUME_DELAY_MS);
  };

  const isStreamingRef = useRef(false);
  useEffect(() => {
    const wasStreaming = isStreamingRef.current;
    isStreamingRef.current = isStreaming;

    if (!interactionActive) return;

    if (isStreaming && !wasStreaming) {
      // Streaming just started — ensure VAD is paused
      pauseVAD();
    } else if (!isStreaming && wasStreaming) {
      // Streaming just ended — resume VAD after delay
      resumeVADDelayed();
    }
  }, [isStreaming, interactionActive]);

  const isQueueActiveRef = useRef(false);
  useEffect(() => {
    isQueueActiveRef.current = isQueueActive;
  }, [isQueueActive]);

  // Guard: skip already-processed results (React StrictMode double-fires effects)
  const lastProcessedSeq = useRef(0);

  // ASR transcript handling
  useEffect(() => {
    if (!asrResult) return;
    if (asrResult.seq <= lastProcessedSeq.current) return;
    lastProcessedSeq.current = asrResult.seq;
    const asrTranscript = asrResult.text;
    const state = useMicStore.getState();

    // Interactive mode: when active, auto-send ASR transcripts
    if (state.interactionActive) {

      // During TTS playback: interrupt and send
      if (isQueueActiveRef.current) stopTTSPlayback();

      // Show transcript
      setLastTranscript(asrTranscript);
      if (lastTranscriptTimerRef.current) clearTimeout(lastTranscriptTimerRef.current);
      lastTranscriptTimerRef.current = setTimeout(() => setLastTranscript(''), 3000);

      // Send, then pause VAD
      if (interactionTimerRef.current) {
        clearTimeout(interactionTimerRef.current);
        interactionTimerRef.current = null;
      }
      handleSendText(asrTranscript);
      pauseVAD();
    } else {
      // Not in interaction and no trigger word: fill chat input as dictation
      pushExternalDraft(asrTranscript);
    }
  }, [asrResult]); // eslint-disable-line react-hooks/exhaustive-deps

  // Deactivate interaction when agent or conversation changes
  useEffect(() => {
    const state = useMicStore.getState();
    if (state.interactionActive) {
      deactivateInteraction();
      if (interactionTimerRef.current) {
        clearTimeout(interactionTimerRef.current);
        interactionTimerRef.current = null;
      }
    }
  }, [agentId, currentConversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 30s idle timer — only for trigger word flow (not PTT)
  useEffect(() => {
    if (!interactionActive || pttActive) return;

    if (!isStreaming && !isQueueActive) {
      if (interactionTimerRef.current) clearTimeout(interactionTimerRef.current);
      interactionTimerRef.current = setTimeout(() => {
        deactivateInteraction();
        interactionTimerRef.current = null;
      }, INTERACTION_IDLE_MS);
    } else {
      if (interactionTimerRef.current) {
        clearTimeout(interactionTimerRef.current);
        interactionTimerRef.current = null;
      }
    }
  }, [interactionActive, pttActive, isStreaming, isQueueActive, deactivateInteraction]);

  // Resume VAD when interaction ends (in case it was paused)
  useEffect(() => {
    if (!interactionActive) {
      if (vadPausedRef.current) {
        if (resumeTimerRef.current) { clearTimeout(resumeTimerRef.current); resumeTimerRef.current = null; }
        useMicStore.getState().resumeListening();
        vadPausedRef.current = false;
      }
      setLastTranscript('');
    }
  }, [interactionActive]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (interactionTimerRef.current) clearTimeout(interactionTimerRef.current);
      if (lastTranscriptTimerRef.current) clearTimeout(lastTranscriptTimerRef.current);
      if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    };
  }, []);

  return {
    asrStatus,
    interactionActive,
    pttActive,
    lastTranscript,
    isQueueActive,
  };
}
