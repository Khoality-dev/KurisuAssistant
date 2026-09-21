import { describe, expect, it } from 'vitest';
import type { SpeechSegment } from './speech';
import { SLEW_MS_PER_SAMPLE, createSpeechClockState, curveAt, sampleSpeech } from './speechClock';

const segment = (over: Partial<SpeechSegment> = {}): SpeechSegment => ({
  text: 'Hello there.',
  startedAt: 1000,
  durationMs: 1000,
  windowMs: 40,
  curve: [0, 0.2, 0.4, 0.6, 0.8, 1, 1, 1, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  cues: [],
  ...over,
});

describe('curveAt', () => {
  it('reads the window the position falls in and interpolates toward the next', () => {
    const curve = [0, 1, 0];
    expect(curveAt(curve, 40, 0)).toBe(0);
    expect(curveAt(curve, 40, 20)).toBeCloseTo(0.5);
    expect(curveAt(curve, 40, 40)).toBe(1);
    expect(curveAt(curve, 40, 60)).toBeCloseTo(0.5);
  });

  it('uses the window the curve was computed with, not a constant', () => {
    const curve = [0, 1];
    expect(curveAt(curve, 33.3, 33.3)).toBeCloseTo(1);
    expect(curveAt(curve, 50, 33.3)).toBeCloseTo(0.666);
  });

  it('is silent past the end and for an empty curve', () => {
    expect(curveAt([0, 1], 40, 80)).toBe(0);
    expect(curveAt([0, 1], 40, 1000)).toBe(0);
    expect(curveAt([], 40, 0)).toBe(0);
    expect(curveAt([1], 40, -1)).toBe(0);
  });
});

describe('sampleSpeech', () => {
  it('is silent and not playing with no segment', () => {
    const state = createSpeechClockState();
    expect(sampleSpeech(null, null, 5000, state)).toEqual({ amplitude: 0, isPlaying: false, positionMs: 0 });
  });

  it('follows the wall clock from startedAt', () => {
    const state = createSpeechClockState();
    expect(sampleSpeech(segment(), null, 1000, state).amplitude).toBe(0);
    expect(sampleSpeech(segment(), null, 1200, state)).toEqual({ amplitude: 1, isPlaying: true, positionMs: 200 });
    expect(sampleSpeech(segment(), null, 1060, state).amplitude).toBeCloseTo(0.3);
  });

  it('keeps isPlaying up past the end of the curve, with a closed mouth', () => {
    const state = createSpeechClockState();
    expect(sampleSpeech(segment(), null, 2500, state)).toEqual({ amplitude: 0, isPlaying: true, positionMs: 1500 });
  });

  it('holds a silent mouth for the duration when synthesis left no curve', () => {
    const state = createSpeechClockState();
    expect(sampleSpeech(segment({ curve: null }), null, 1300, state)).toEqual({ amplitude: 0, isPlaying: true, positionMs: 300 });
  });

  it('a start latency of 150 ms is corrected by the first sync, one slew step per sample', () => {
    // The audio element reported `playing` at 1000, but its output buffer put
    // the sound 150 ms behind the wall clock. The sync at 1500 says the audio
    // is at 350, not 500.
    const state = createSpeechClockState();
    sampleSpeech(segment(), null, 1400, state);
    const sync = { positionMs: 350, at: 1500 };
    const offsets: number[] = [];
    for (let now = 1500; now <= 1500 + 16 * 12; now += 16) {
      sampleSpeech(segment(), sync, now, state);
      offsets.push(state.offsetMs);
    }
    // Never more than one slew step per sample, and settled on 150 within
    // ceil(150 / 20) = 8 samples.
    for (let i = 1; i < offsets.length; i++) {
      expect(Math.abs(offsets[i] - offsets[i - 1])).toBeLessThanOrEqual(SLEW_MS_PER_SAMPLE + 1e-9);
    }
    expect(offsets[7]).toBe(150);
    expect(offsets[11]).toBe(150);
    expect(sampleSpeech(segment(), sync, 1700, state).positionMs).toBe(550);
  });

  it('a sync from a previous segment is ignored, and a new segment starts from zero', () => {
    const state = createSpeechClockState();
    const first = segment({ startedAt: 1000 });
    sampleSpeech(first, { positionMs: 100, at: 1400 }, 1400, state);
    for (let i = 0; i < 20; i++) sampleSpeech(first, { positionMs: 100, at: 1400 }, 1400 + i * 16, state);
    expect(state.offsetMs).toBe(300);
    const second = segment({ startedAt: 3000 });
    const sample = sampleSpeech(second, { positionMs: 100, at: 1400 }, 3200, state);
    expect(state.offsetMs).toBe(0);
    expect(sample.positionMs).toBe(200);
  });
});
