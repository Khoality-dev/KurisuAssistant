/**
 * Playback tells the character feed when a sentence actually begins (#238):
 * on the audio element's `playing` event, never on the call to `play()` — the
 * decode and output latency between the two would otherwise lead the mouth —
 * and where the audio is a few times a second after that.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROGRESS_INTERVAL_MS, computeAmplitudeCurve, playSegment, type PlaybackDeps } from './useAudioAmplitude';

/** An audio element a test drives by hand. */
class FakeAudio extends EventTarget {
  currentTime = 0;
  paused = true;
  played = false;
  constructor(public readonly src: string) { super(); }
  play() { this.played = true; this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  emit(type: string) { this.dispatchEvent(new Event(type)); }
}

describe('playSegment', () => {
  let audio: FakeAudio;
  let clock: number;
  const deps: PlaybackDeps = {
    createAudio: (url) => { audio = new FakeAudio(url); return audio as unknown as HTMLAudioElement; },
    now: () => clock,
  };
  const blob = new Blob(['x']);

  beforeEach(() => {
    clock = 1000;
    vi.useFakeTimers();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports the sentence on playing — not on play() — with the clock read then', async () => {
    const onPlaying = vi.fn();
    const curve = { values: [0, 1], windowMs: 33.3, durationMs: 66.6 };
    const handle = playSegment(blob, curve, { onPlaying }, deps);
    expect(audio.played).toBe(true);
    expect(onPlaying).not.toHaveBeenCalled();
    clock = 1150; // the element took 150 ms to start
    audio.emit('playing');
    expect(onPlaying).toHaveBeenCalledWith(curve, 1150);
    audio.emit('ended');
    await expect(handle.done).resolves.toBeUndefined();
  });

  it('reports the position every half second while playing, and stops at the end', () => {
    const onProgress = vi.fn();
    playSegment(blob, null, { onProgress }, deps);
    audio.emit('playing');
    audio.currentTime = 0.4;
    clock = 1500;
    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS);
    expect(onProgress).toHaveBeenCalledWith(400, 1500);
    audio.emit('ended');
    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS * 3);
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it('stop() settles the promise so a caller never waits on a sentence that was cut short', async () => {
    const handle = playSegment(blob, null, {}, deps);
    audio.emit('playing');
    handle.stop();
    expect(audio.paused).toBe(true);
    await expect(handle.done).resolves.toBeUndefined();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });

  it('a playback error rejects', async () => {
    const handle = playSegment(blob, null, {}, deps);
    audio.emit('error');
    await expect(handle.done).rejects.toBeDefined();
  });
});

describe('computeAmplitudeCurve', () => {
  it("carries the curve's own window and the duration, not a constant", () => {
    const sampleRate = 16000;
    const samples = new Float32Array(sampleRate); // one second
    for (let i = 0; i < sampleRate / 2; i++) samples[i] = 0.5;
    const curve = computeAmplitudeCurve(samples, sampleRate);
    expect(curve.windowMs).toBeCloseTo((533 / 16000) * 1000, 3);
    expect(curve.durationMs).toBe(1000);
    expect(curve.values[0]).toBe(1);        // rms 0.5 × 4, clamped
    expect(curve.values[curve.values.length - 1]).toBe(0);
    expect(curve.values).toHaveLength(Math.ceil(16000 / 533));
  });
});
