import { useState, useEffect, useRef } from 'react';
import { useMicStore } from '../store/micStore';
import { useAgentStore } from '../store/agentStore';
import { apiClient } from '../api/client';
import { storage } from '../utils/storage';

interface UseInteractiveASRParams {
  agentId: number | null;
  currentConversationId: number | null;
  isStreaming: boolean;
  isQueueActive: boolean;
  handleSendText: (text: string) => Promise<void>;
  pushExternalDraft: (text: string) => void;
}

export function useInteractiveASR({
  agentId,
  currentConversationId,
  isStreaming,
  isQueueActive,
  handleSendText,
  pushExternalDraft,
}: UseInteractiveASRParams) {
  const {
    status: asrStatus, result: asrResult,
    interactionActive, activateInteraction, deactivateInteraction,
    pttActive,
  } = useMicStore();
  const storeAgents = useAgentStore(state => state.agents);
  const interactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingAutoSendRef = useRef<string | null>(null);
  const INTERACTION_IDLE_MS = 30_000;
  const [lastTranscript, setLastTranscript] = useState('');
  const lastTranscriptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isStreamingRef = useRef(false);
  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // Guard: skip already-processed results (React StrictMode double-fires effects)
  const lastProcessedSeq = useRef(0);

  // ASR transcript handling
  useEffect(() => {
    if (!asrResult) return;
    const processResult = async () => {
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

      // If fast mode detected trigger word, re-transcribe with full quality
      let finalText = asrTranscript;
      if (asrResult.fast && asrResult.audio && hasTrigger) {
        try {
          let language: string | undefined;
          let model: string | undefined;
          const asrMode = storage.getASRMode();
          if (asrMode === 'routing') {
            const modelMap = storage.getASRModelMap();
            const mappedLanguages = modelMap.map((e) => e.language).filter((l) => !!l);
            const detected = await apiClient.detectLanguage(
              asrResult.audio,
              mappedLanguages.length > 0 ? { languages: mappedLanguages } : undefined,
            );
            language = detected.language || undefined;
            model = language ? storage.getASRModelForLanguage(language) : undefined;
          } else {
            const fixedModel = storage.getASRFixedModel();
            if (fixedModel) model = fixedModel;
          }
          const full = await apiClient.transcribe(asrResult.audio, { language, model });
          if (full.text.trim()) finalText = full.text.trim();
        } catch {
          // Fall back to fast-mode text
        }
      }

      // Show transcript
      setLastTranscript(finalText);
      if (lastTranscriptTimerRef.current) clearTimeout(lastTranscriptTimerRef.current);
      lastTranscriptTimerRef.current = setTimeout(() => setLastTranscript(''), 3000);

      // Auto-send
      if (isStreamingRef.current) {
        pendingAutoSendRef.current = finalText;
      } else {
        if (interactionTimerRef.current) {
          clearTimeout(interactionTimerRef.current);
          interactionTimerRef.current = null;
        }
        handleSendText(finalText);
      }
    } else {
      // Not in interaction and no trigger word: fill chat input as dictation
      pushExternalDraft(asrTranscript);
    }
    };
    processResult();
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
      pendingAutoSendRef.current = null;
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
        pendingAutoSendRef.current = null;
      }, INTERACTION_IDLE_MS);
    } else {
      if (interactionTimerRef.current) {
        clearTimeout(interactionTimerRef.current);
        interactionTimerRef.current = null;
      }
    }
  }, [interactionActive, pttActive, isStreaming, isQueueActive, deactivateInteraction]);

  // Handle pending auto-send when streaming finishes
  useEffect(() => {
    if (!isStreaming && pendingAutoSendRef.current) {
      const text = pendingAutoSendRef.current;
      pendingAutoSendRef.current = null;
      handleSendText(text);
    }
  }, [isStreaming]); // eslint-disable-line react-hooks/exhaustive-deps

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
