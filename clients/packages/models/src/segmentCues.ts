/**
 * The feelings of the sentence being spoken, handed to the face as the audio
 * reaches them (#244).
 *
 * A `SpeechSegment` carries its cues at a delay into the sentence. The
 * surface already clocks the audio's position every frame (`sampleSpeech`);
 * this turns that position into at most one cue per frame: each cue once,
 * when the position passes its delay, and the latest when a frame passes
 * several. The cue holds until the next one or until speech ends — the TTS
 * queue keeps the segment up across sentences and drops it once, which is the
 * driver's cue to let the feeling go.
 *
 * No DOM, no timers: the position is a parameter, as in `speechClock.ts`.
 */
import type { EmotionCue } from './characterDriver';
import type { SpeechSegment } from './speech';

export interface SegmentCueState {
  /** Which segment `taken` counts for; a new segment starts from none taken. */
  segmentStartedAt: number | null;
  /** How many of the segment's cues, in delay order, have been handed over. */
  taken: number;
}

export function createSegmentCueState(): SegmentCueState {
  return { segmentStartedAt: null, taken: 0 };
}

/** The cue to show this frame, or null. `state` is the surface's and is mutated. */
export function takeSegmentCue(segment: SpeechSegment | null, positionMs: number, state: SegmentCueState): EmotionCue | null {
  if (!segment) {
    state.segmentStartedAt = null;
    state.taken = 0;
    return null;
  }
  if (state.segmentStartedAt !== segment.startedAt) {
    state.segmentStartedAt = segment.startedAt;
    state.taken = 0;
  }
  const cues = segment.cues.length > 1 ? [...segment.cues].sort((a, b) => a.delayMs - b.delayMs) : segment.cues;
  let due: EmotionCue | null = null;
  while (state.taken < cues.length && cues[state.taken].delayMs <= positionMs) {
    due = { emotion: cues[state.taken].emotion, hold_ms: null };
    state.taken++;
  }
  return due;
}
