import { describe, expect, it } from 'vitest';
import { voiceBarPhase, isVoiceProblem, type VoiceBarInput } from './voiceBarPhase';

/**
 * Which state the voice bar is in (#345): one answer from everything voice mode
 * knows, so the first line never says two things at once.
 */

const idle: VoiceBarInput = {
  problem: null,
  triggerWord: 'Kurisu',
  interactionActive: false,
  userSpeaking: false,
  asrStatus: 'listening',
  isStreaming: false,
  isSpeaking: false,
};

const inInteraction = (over: Partial<VoiceBarInput>) => voiceBarPhase({ ...idle, interactionActive: true, ...over });

describe('the voice bar', () => {
  it('waits for the wake word before an interaction', () => {
    expect(voiceBarPhase(idle)).toBe('waiting');
    expect(voiceBarPhase({ ...idle, userSpeaking: true })).toBe('waiting');
  });

  it('in an interaction: listening while someone talks, then transcribing', () => {
    expect(inInteraction({ userSpeaking: true })).toBe('listening');
    expect(inInteraction({ asrStatus: 'processing' })).toBe('transcribing');
  });

  it('then the assistant thinking while the reply streams, and speaking while it is read aloud', () => {
    expect(inInteraction({ isStreaming: true })).toBe('thinking');
    expect(inInteraction({ isSpeaking: true })).toBe('speaking');
    expect(inInteraction({ isStreaming: true, isSpeaking: true })).toBe('speaking');
  });

  it('talking over the reply is listening', () => {
    expect(inInteraction({ isSpeaking: true, userSpeaking: true })).toBe('listening');
  });

  it('with the reply done and nobody talking, the 30-second window runs', () => {
    expect(inInteraction({})).toBe('window');
  });

  it('with no wake word set, nothing can start: that is the state until one is set', () => {
    expect(voiceBarPhase({ ...idle, triggerWord: null })).toBe('no-wake-word');
    expect(voiceBarPhase({ ...idle, triggerWord: '  ' })).toBe('no-wake-word');
  });

  it('a mic that cannot listen outranks everything else', () => {
    expect(voiceBarPhase({ ...idle, problem: 'mic-blocked', triggerWord: null })).toBe('mic-blocked');
    expect(inInteraction({ problem: 'asr-unavailable', isStreaming: true })).toBe('asr-unavailable');
    expect(voiceBarPhase({ ...idle, problem: 'no-microphone' })).toBe('no-microphone');
  });

  it('knows which states are problems', () => {
    expect(isVoiceProblem('no-wake-word')).toBe(true);
    expect(isVoiceProblem('mic-blocked')).toBe(true);
    expect(isVoiceProblem('window')).toBe(false);
    expect(isVoiceProblem('waiting')).toBe(false);
  });
});
