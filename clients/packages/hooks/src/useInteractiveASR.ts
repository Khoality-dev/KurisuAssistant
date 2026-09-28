import { useState, useEffect, useRef } from 'react';
import { useMicStore } from '@kurisu/state';

/**
 * Whether a transcript carries the wake word: anywhere in it, in any case, as
 * Android's `VoiceInteractionManager` hears it.
 */
export function heardWakeWord(transcript: string, word: string | null): boolean {
  return !!word && transcript.toLowerCase().includes(word.toLowerCase());
}

interface UseInteractiveASRParams {
  isStreaming: boolean;
  isQueueActive: boolean;
  /** `newConversation`: this is an interaction's first message, and each interaction is a new conversation. */
  handleSendText: (text: string, opts: { newConversation: boolean }) => Promise<void>;
  stopTTSPlayback: () => void;
}

export function useInteractiveASR({
  isStreaming,
  isQueueActive,
  handleSendText,
  stopTTSPlayback,
}: UseInteractiveASRParams) {
  const {
    status: asrStatus, result: asrResult,
    interactionActive, deactivateInteraction, userSpeaking,
  } = useMicStore();
  const interactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const INTERACTION_IDLE_MS = 30_000;
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const RESUME_DELAY_MS = 10000;
  // What was last said, for the voice bar's second line: it stays for the
  // whole interaction (#345).
  const [lastTranscript, setLastTranscript] = useState('');
  // When the wake word started the current interaction, for the chat's
  // new-conversation marker (#345).
  const [wokeAt, setWokeAt] = useState<number | null>(null);
  // When the 30-second window opened, or null while it is shut — the voice bar
  // drains its top line from here (#345).
  const [windowStartedAt, setWindowStartedAt] = useState<number | null>(null);

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
    // The mic listens only in voice mode; a transcript still in flight when it
    // was turned off is dropped (#253).
    if (!state.voiceMode) return;

    // In an interaction everything said is sent. In voice mode the wake word
    // starts one and is itself the first message (#337, #253); anything else
    // said there is not for the assistant yet, and is dropped.
    const woken = !state.interactionActive && heardWakeWord(asrTranscript, state.triggerWord);
    if (woken) {
      state.activateInteraction();
      setWokeAt(Date.now());
    }
    if (state.interactionActive || woken) {

      // During TTS playback: interrupt and send
      if (isQueueActiveRef.current) stopTTSPlayback();

      setLastTranscript(asrTranscript);

      // Send, then pause VAD
      if (interactionTimerRef.current) {
        clearTimeout(interactionTimerRef.current);
        interactionTimerRef.current = null;
      }
      // Each interaction is a new conversation: the wake word's sentence opens it.
      handleSendText(asrTranscript, { newConversation: woken });
      pauseVAD();
    }
  }, [asrResult]); // eslint-disable-line react-hooks/exhaustive-deps

  // An interaction ends 30 s after the assistant's last reply — once it has
  // finished streaming and speaking — with nothing said since; voice mode then
  // waits for the wake word again (#253). Talking, and the transcription that
  // follows, hold the window shut; it opens again, full, when they are over
  // (#345). A persona or conversation change does not end it: a new chat's
  // first message creates its conversation.
  const transcribing = asrStatus === 'processing';
  useEffect(() => {
    if (interactionTimerRef.current) {
      clearTimeout(interactionTimerRef.current);
      interactionTimerRef.current = null;
    }
    if (!interactionActive || isStreaming || isQueueActive || userSpeaking || transcribing) {
      setWindowStartedAt(null);
      return;
    }
    setWindowStartedAt(Date.now());
    interactionTimerRef.current = setTimeout(() => {
      interactionTimerRef.current = null;
      setWindowStartedAt(null);
      deactivateInteraction();
    }, INTERACTION_IDLE_MS);
  }, [interactionActive, isStreaming, isQueueActive, userSpeaking, transcribing, deactivateInteraction]);

  // Resume VAD when interaction ends (in case it was paused)
  useEffect(() => {
    if (!interactionActive) {
      if (vadPausedRef.current) {
        if (resumeTimerRef.current) { clearTimeout(resumeTimerRef.current); resumeTimerRef.current = null; }
        useMicStore.getState().resumeListening();
        vadPausedRef.current = false;
      }
      setLastTranscript('');
      setWokeAt(null);
    }
  }, [interactionActive]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (interactionTimerRef.current) clearTimeout(interactionTimerRef.current);
      if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    };
  }, []);

  return {
    asrStatus,
    interactionActive,
    lastTranscript,
    isQueueActive,
    wokeAt,
    windowStartedAt,
  };
}
