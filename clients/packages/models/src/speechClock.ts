/**
 * The mouth's clock: amplitude now, from one spoken sentence.
 *
 * The producer pushes a `SpeechSegment` once — the sentence's RMS curve and
 * the moment its audio began — and every surface derives the amplitude on its
 * own frame from that, instead of being fed a number thirty times a second
 * across a process boundary that the browser throttles whenever the main
 * window is hidden (#238). A `SpeechSync` every half second carries the
 * producer's real playback position; the difference between it and the wall
 * clock is slewed in gently, so output buffering (often 100–300 ms on a phone)
 * is absorbed within the first sync rather than accumulated over a sentence.
 *
 * No DOM, no timers: `now` is a parameter, so a test can run a sentence at
 * any speed.
 */
import type { SpeechSegment, SpeechSync } from './speech';

/** The most the clock moves toward a sync per sample, so a correction is a glide, not a jump. */
export const SLEW_MS_PER_SAMPLE = 20;

export interface SpeechClockState {
  /** Which segment the offset belongs to; a new segment starts from zero. */
  segmentStartedAt: number | null;
  /** How far the wall clock runs ahead of the audio, in milliseconds. */
  offsetMs: number;
}

export interface SpeechSample {
  /** 0..1, the curve at the audio's current position (0 past the end, or with no curve). */
  amplitude: number;
  /** A sentence is up: the queue keeps this true across sentences and drops it once at the end. */
  isPlaying: boolean;
  /** The audio's position inside the sentence, as this clock believes it. */
  positionMs: number;
}

export function createSpeechClockState(): SpeechClockState {
  return { segmentStartedAt: null, offsetMs: 0 };
}

/**
 * The curve's value at a position, interpolated between windows so a
 * continuous blendshape does not step at 30 Hz.
 */
export function curveAt(curve: number[], windowMs: number, positionMs: number): number {
  if (curve.length === 0 || windowMs <= 0 || positionMs < 0) return 0;
  const exact = positionMs / windowMs;
  const i = Math.floor(exact);
  if (i >= curve.length) return 0;
  const a = curve[i];
  const b = i + 1 < curve.length ? curve[i + 1] : 0;
  return a + (b - a) * (exact - i);
}

/**
 * One sample of the mouth, and the clock's own bookkeeping.
 *
 * `state` is mutated: it is the surface's, one per driver, and carries the
 * slewed offset from sample to sample.
 */
export function sampleSpeech(
  segment: SpeechSegment | null,
  sync: SpeechSync | null,
  now: number,
  state: SpeechClockState,
): SpeechSample {
  if (!segment) {
    state.segmentStartedAt = null;
    state.offsetMs = 0;
    return { amplitude: 0, isPlaying: false, positionMs: 0 };
  }

  if (state.segmentStartedAt !== segment.startedAt) {
    state.segmentStartedAt = segment.startedAt;
    state.offsetMs = 0;
  }

  // A sync that belongs to this segment says where the audio really was at
  // `sync.at`; the wall clock had run `sync.at - startedAt` by then.
  if (sync && sync.at >= segment.startedAt) {
    const target = (sync.at - segment.startedAt) - sync.positionMs;
    const delta = target - state.offsetMs;
    state.offsetMs += Math.max(-SLEW_MS_PER_SAMPLE, Math.min(SLEW_MS_PER_SAMPLE, delta));
  }

  const positionMs = Math.max(0, now - segment.startedAt - state.offsetMs);
  const past = positionMs >= segment.durationMs;
  const amplitude = past || !segment.curve ? 0 : curveAt(segment.curve, segment.windowMs, positionMs);
  return { amplitude, isPlaying: true, positionMs };
}
