import { useState, useEffect, useRef } from 'react';
import { useMicStore } from '../store/micStore';
import { useAgentStore } from '../store/agentStore';

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
    interactionActive, activateInteraction, deactivateInteraction,
    pttActive,
  } = useMicStore();
  const storeAgents = useAgentStore(state => state.agents);
  const interactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const INTERACTION_IDLE_MS = 30_000;
  const [lastTranscript, setLastTranscript] = useState('');
  const lastTranscriptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isStreamingRef = useRef(false);
  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  const isQueueActiveRef = useRef(false);
  useEffect(() => {
    isQueueActiveRef.current = isQueueActive;
  }, [isQueueActive]);

  // Guard: skip already-processed results (React StrictMode double-fires effects)
  const lastProcessedSeq = useRef(0);
  // Cooldown: prevent rapid-fire sends (wait for streaming state to propagate)
  const lastSendTime = useRef(0);
  const SEND_COOLDOWN_MS = 2000;

  // ASR transcript handling
  useEffect(() => {
    if (!asrResult) return;
    if (asrResult.seq <= lastProcessedSeq.current) return;
    lastProcessedSeq.current = asrResult.seq;
    const asrTranscript = asrResult.text;
    const state = useMicStore.getState();

    // Use Administrator agent's persona trigger word
    const adminAgent = storeAgents.find(a => a.is_system);
    const triggerWord = adminAgent?.persona?.trigger_word?.trim();
    const hasTrigger = triggerWord && asrTranscript.toLowerCase().includes(triggerWord.toLowerCase());

    if (state.interactionActive || hasTrigger) {
      // Activate interaction if trigger word detected
      if (!state.interactionActive) activateInteraction();

      // During agent generation: drop speech
      if (isStreamingRef.current) return;

      // Cooldown: drop if sent too recently (streaming state may not have propagated)
      if (Date.now() - lastSendTime.current < SEND_COOLDOWN_MS) return;

      // During TTS playback: interrupt and send
      if (isQueueActiveRef.current) stopTTSPlayback();

      // Show transcript
      setLastTranscript(asrTranscript);
      if (lastTranscriptTimerRef.current) clearTimeout(lastTranscriptTimerRef.current);
      lastTranscriptTimerRef.current = setTimeout(() => setLastTranscript(''), 3000);

      // Send
      if (interactionTimerRef.current) {
        clearTimeout(interactionTimerRef.current);
        interactionTimerRef.current = null;
      }
      lastSendTime.current = Date.now();
      handleSendText(asrTranscript);
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

  // Clear transcript when interaction ends
  useEffect(() => {
    if (!interactionActive) {
      setLastTranscript('');
    }
  }, [interactionActive]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (interactionTimerRef.current) clearTimeout(interactionTimerRef.current);
      if (lastTranscriptTimerRef.current) clearTimeout(lastTranscriptTimerRef.current);
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
