/**
 * A sentence's feelings are shown when the audio reaches them (#244).
 *
 * The surface samples the spoken sentence every frame on its own clock; this
 * pins which cue that sample hands the driver: each one once, when the
 * position passes its delay, the latest when several are passed in one frame,
 * and afresh for every new sentence.
 */
import { describe, expect, it } from 'vitest';
import type { SpeechSegment } from './speech';
import { createSegmentCueState, takeSegmentCue } from './segmentCues';

const sentence = (cues: SpeechSegment['cues'], startedAt = 1000): SpeechSegment => ({
  text: 'I am glad. But this is sad.',
  startedAt,
  durationMs: 2000,
  windowMs: 33,
  curve: null,
  cues,
});

describe('takeSegmentCue', () => {
  it('hands a cue over once, when the audio reaches its delay, and holds it until the next', () => {
    const state = createSegmentCueState();
    const s = sentence([{ emotion: 'happy', delayMs: 0 }, { emotion: 'sad', delayMs: 900 }]);
    expect(takeSegmentCue(s, 0, state)).toEqual({ emotion: 'happy', hold_ms: null });
    expect(takeSegmentCue(s, 16, state)).toBeNull();
    expect(takeSegmentCue(s, 899, state)).toBeNull();
    expect(takeSegmentCue(s, 900, state)).toEqual({ emotion: 'sad', hold_ms: null });
    expect(takeSegmentCue(s, 1500, state)).toBeNull();
  });

  it('when a frame passes several cues, the latest one is what shows', () => {
    const state = createSegmentCueState();
    const s = sentence([{ emotion: 'happy', delayMs: 100 }, { emotion: 'surprised', delayMs: 200 }]);
    expect(takeSegmentCue(s, 250, state)).toEqual({ emotion: 'surprised', hold_ms: null });
    expect(takeSegmentCue(s, 300, state)).toBeNull();
  });

  it('takes the cues in delay order whatever order they were listed in', () => {
    const state = createSegmentCueState();
    const s = sentence([{ emotion: 'sad', delayMs: 900 }, { emotion: 'happy', delayMs: 0 }]);
    expect(takeSegmentCue(s, 0, state)).toEqual({ emotion: 'happy', hold_ms: null });
    expect(takeSegmentCue(s, 950, state)).toEqual({ emotion: 'sad', hold_ms: null });
  });

  it('starts over for the next sentence, and forgets everything between turns', () => {
    const state = createSegmentCueState();
    expect(takeSegmentCue(sentence([{ emotion: 'happy', delayMs: 0 }], 1000), 10, state)?.emotion).toBe('happy');
    expect(takeSegmentCue(sentence([{ emotion: 'angry', delayMs: 0 }], 3000), 10, state)?.emotion).toBe('angry');
    expect(takeSegmentCue(null, 0, state)).toBeNull();
    expect(takeSegmentCue(sentence([{ emotion: 'angry', delayMs: 0 }], 3000), 10, state)?.emotion).toBe('angry');
  });

  it('a sentence with no cues changes nothing', () => {
    const state = createSegmentCueState();
    expect(takeSegmentCue(sentence([]), 500, state)).toBeNull();
  });
});
