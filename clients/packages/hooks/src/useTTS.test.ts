/**
 * A queued sentence carries its feelings into the segment the character
 * clocks (#244): each at its fraction of the way through the audio, and
 * through the silent hold of a sentence that could not be synthesized.
 */
import { describe, expect, it } from 'vitest';
import { FAILED_SENTENCE_MS, segmentOf } from './useTTS';

describe('segmentOf', () => {
  it('places each cue at its fraction of the audio', () => {
    const curve = { values: [0, 1], windowMs: 33.3, durationMs: 2000 };
    expect(segmentOf('Hello. Oh no.', curve, 5000, [
      { emotion: 'happy', atFraction: 0 },
      { emotion: 'sad', atFraction: 0.5 },
    ])).toEqual({
      text: 'Hello. Oh no.',
      startedAt: 5000,
      durationMs: 2000,
      windowMs: 33.3,
      curve: [0, 1],
      cues: [{ emotion: 'happy', delayMs: 0 }, { emotion: 'sad', delayMs: 1000 }],
    });
  });

  it('a sentence that could not be synthesized still shows its feelings, across its silent hold', () => {
    const s = segmentOf('Oh no.', null, 5000, [{ emotion: 'sad', atFraction: 0.5 }]);
    expect(s.durationMs).toBe(FAILED_SENTENCE_MS);
    expect(s.cues).toEqual([{ emotion: 'sad', delayMs: FAILED_SENTENCE_MS / 2 }]);
  });

  it('a sentence with no feelings carries none', () => {
    expect(segmentOf('Hi.', null, 0).cues).toEqual([]);
  });
});
