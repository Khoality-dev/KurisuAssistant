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
  clearExternalDraft: () => void;
}

export function useInteractiveASR({
  agentId,
  currentConversationId,
  isStreaming,
  isQueueActive,
  handleSendText,
  pushExternalDraft,
  clearExternalDraft,
}: UseInteractiveASRParams) {
  const {
    status: asrStatus, result: asrResult,
    interactiveMode, enableInteractiveMode, disableInteractiveMode,
    interactionActive, activateInteraction, deactivateInteraction,
  } = useMicStore();
  const storeAgents = useAgentStore(state => state.agents);
  const interactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingAutoSendRef = useRef<string | null>(null);
  const ttsPlayedForResponseRef = useRef(false);
  const INTERACTION_IDLE_MS = 30_000;
  const [lastTranscript, setLastTranscript] = useState('');
  const lastTranscriptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep a ref to isStreaming to avoid stale closures
  const isStreamingRef = useRef(false);
  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // ASR transcript handling: branch on interactive mode and interaction state
  useEffect(() => {
    if (!asrResult) return;
    const asrTranscript = asrResult.text;
    const state = useMicStore.getState();

    const selectedAgent = storeAgents.find(a => a.id === agentId);
    const triggerWord = selectedAgent?.persona?.trigger_word?.trim();
    const hasTrigger = triggerWord && asrTranscript.toLowerCase().includes(triggerWord.toLowerCase());

    if (state.interactiveMode) {
      // Interactive mode: always show transcript visually
      setLastTranscript(asrTranscript);
      if (lastTranscriptTimerRef.current) clearTimeout(lastTranscriptTimerRef.current);
      lastTranscriptTimerRef.current = setTimeout(() => setLastTranscript(''), 3000);

      if (state.interactionActive || hasTrigger) {
        // Interaction active or trigger word detected: auto-send
        if (!state.interactionActive) activateInteraction();

        if (isStreamingRef.current) {
          pendingAutoSendRef.current = asrTranscript;
        } else {
          if (interactionTimerRef.current) {
            clearTimeout(interactionTimerRef.current);
            interactionTimerRef.current = null;
          }
          ttsPlayedForResponseRef.current = false;
          handleSendText(asrTranscript);
        }
      }
      // If not active and no trigger word, show transcript without sending
    } else {
      // Typing mode: put text in input field (dictation)
      pushExternalDraft(asrTranscript);
      // Check trigger word, then enable interaction mode and auto-send
      if (hasTrigger) {
        enableInteractiveMode();
        activateInteraction();
        ttsPlayedForResponseRef.current = false;
        handleSendText(asrTranscript).finally(() => clearExternalDraft());
      }
    }
  }, [asrResult, clearExternalDraft, pushExternalDraft]); // eslint-disable-line react-hooks/exhaustive-deps

  // Disable interactive mode when agent or conversation changes
  useEffect(() => {
    if (useMicStore.getState().interactiveMode) {
      disableInteractiveMode();
      if (interactionTimerRef.current) {
        clearTimeout(interactionTimerRef.current);
        interactionTimerRef.current = null;
      }
      pendingAutoSendRef.current = null;
    }
  }, [agentId, currentConversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Start a 30s idle timer after streaming and TTS finish; keep interactive mode enabled
  useEffect(() => {
    if (!interactiveMode || !interactionActive) return;
    // Timer starts when: not streaming AND TTS queue not active
    if (!isStreaming && !isQueueActive) {
      if (interactionTimerRef.current) {
        clearTimeout(interactionTimerRef.current);
      }
      interactionTimerRef.current = setTimeout(() => {
        deactivateInteraction();
        interactionTimerRef.current = null;
        pendingAutoSendRef.current = null;
      }, INTERACTION_IDLE_MS);
    } else {
      // Still streaming or playing TTS, so clear the idle timer
      if (interactionTimerRef.current) {
        clearTimeout(interactionTimerRef.current);
        interactionTimerRef.current = null;
      }
    }
  }, [interactiveMode, interactionActive, isStreaming, isQueueActive, deactivateInteraction]);

  // Handle pending auto-send when streaming finishes
  useEffect(() => {
    if (!isStreaming && pendingAutoSendRef.current) {
      const text = pendingAutoSendRef.current;
      pendingAutoSendRef.current = null;
      ttsPlayedForResponseRef.current = false;
      handleSendText(text);
    }
  }, [isStreaming]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear UI state on interactive mode transitions
  useEffect(() => {
    if (interactiveMode) {
      clearExternalDraft();
    } else {
      setLastTranscript('');
    }
  }, [interactiveMode, clearExternalDraft]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (interactionTimerRef.current) clearTimeout(interactionTimerRef.current);
      if (lastTranscriptTimerRef.current) clearTimeout(lastTranscriptTimerRef.current);
    };
  }, []);

  return {
    asrStatus,
    interactiveMode,
    interactionActive,
    lastTranscript,
    disableInteractiveMode,
    isQueueActive,
  };
}
