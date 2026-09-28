import type { ASRStatus, MicProblem } from '@kurisu/state';

/**
 * What the voice bar says voice mode is doing (#345). One of these at a time,
 * so its first line never says two things at once. The last five are problems:
 * the bar says what is wrong and offers the fix.
 */
export type VoiceBarPhase =
  | 'waiting'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'window'
  | 'no-wake-word'
  | MicProblem;

export interface VoiceBarInput {
  problem: MicProblem | null;
  triggerWord: string | null;
  interactionActive: boolean;
  /** Someone is talking right now. */
  userSpeaking: boolean;
  asrStatus: ASRStatus;
  /** The reply is streaming. */
  isStreaming: boolean;
  /** The reply is being read aloud. */
  isSpeaking: boolean;
}

/**
 * A mic that cannot listen outranks everything: nothing else voice mode could
 * say is true while it lasts. Then a missing wake word, because without one no
 * interaction can start. Inside an interaction, talking wins over the reply —
 * saying something interrupts it — and when nobody is talking and the reply is
 * done, the 30-second window runs.
 */
export function voiceBarPhase(s: VoiceBarInput): VoiceBarPhase {
  if (s.problem) return s.problem;
  if (!s.interactionActive) return s.triggerWord?.trim() ? 'waiting' : 'no-wake-word';
  if (s.userSpeaking) return 'listening';
  if (s.asrStatus === 'processing') return 'transcribing';
  if (s.isSpeaking) return 'speaking';
  if (s.isStreaming) return 'thinking';
  return 'window';
}

const PROBLEMS: ReadonlySet<VoiceBarPhase> = new Set(['no-wake-word', 'no-microphone', 'mic-blocked', 'asr-unavailable']);

/** Whether the bar is showing a problem — the header pill carries a dot then. */
export function isVoiceProblem(phase: VoiceBarPhase): boolean {
  return PROBLEMS.has(phase);
}
