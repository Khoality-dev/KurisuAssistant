import { describe, expect, it } from 'vitest';
import type { VrmIdleSettings } from '@kurisu/models';
import { createIdleState, MAX_IDLE_STEP_MS, stepIdle, type IdleState } from './idle';

const SETTINGS: VrmIdleSettings = {
  procedural: true,
  arms_lowered: true,
  breath_period_ms: 4000,
  breath_amplitude_deg: 2,
  sway_amplitude_deg: 1.5,
  sway_period_ms: 7000,
  blink: { blink_min_interval: 2000, blink_max_interval: 6000, blink_close_duration: 100, blink_hold_duration: 50, blink_open_duration: 100 },
  look_at: 'drift',
  idle_clip_ids: [],
  idle_clip_interval_ms: [8000, 20000],
};

function run(seed: number, steps: number, dt = 16, settings = SETTINGS, attention = false) {
  let state = createIdleState(seed, settings);
  const frames = [];
  for (let i = 0; i < steps; i++) {
    const r = stepIdle(state, dt, settings, { attention });
    state = r.state;
    frames.push(r.frame);
  }
  return { state, frames };
}

describe('stepIdle', () => {
  it('is deterministic for a seed', () => {
    const a = run(42, 500);
    const b = run(42, 500);
    expect(a.frames).toEqual(b.frames);
    expect(a.state).toEqual(b.state);
  });

  it('keeps every blink interval inside [min, max] over ten thousand steps', () => {
    let state: IdleState = createIdleState(7, SETTINGS);
    let sinceLastBlinkEnd = 0;
    let wasClosed = false;
    let blinks = 0;
    for (let i = 0; i < 10_000; i++) {
      const r = stepIdle(state, 16, SETTINGS);
      state = r.state;
      const closing = r.frame.blinkWeight > 0;
      if (closing && !wasClosed) {
        // A blink starts: the wait since the last one ended must be in range
        // (the first wait starts at t=0).
        if (blinks > 0) {
          expect(sinceLastBlinkEnd).toBeGreaterThanOrEqual(SETTINGS.blink.blink_min_interval - 16);
          expect(sinceLastBlinkEnd).toBeLessThanOrEqual(SETTINGS.blink.blink_max_interval + 16);
        }
        blinks++;
      }
      if (!closing && wasClosed) sinceLastBlinkEnd = 0;
      if (!closing) sinceLastBlinkEnd += 16;
      wasClosed = closing;
    }
    expect(blinks).toBeGreaterThan(20);
  });

  it('never blinks for longer than close + hold + open', () => {
    let state = createIdleState(3, SETTINGS);
    let closedFor = 0;
    for (let i = 0; i < 5000; i++) {
      const r = stepIdle(state, 16, SETTINGS);
      state = r.state;
      closedFor = r.frame.blinkWeight > 0 ? closedFor + 16 : 0;
      expect(closedFor).toBeLessThanOrEqual(100 + 50 + 100 + 32);
    }
  });

  it('keeps its phase continuous across a 200 ms hitch', () => {
    const smooth = run(1, 100);
    const before = smooth.frames[99];
    const afterHitch = stepIdle(smooth.state, 200, SETTINGS).frame;
    const afterFrame = stepIdle(smooth.state, MAX_IDLE_STEP_MS, SETTINGS).frame;
    // A 200 ms step advances the clocks by the same clamped amount as a 50 ms one.
    expect(afterHitch.breathPitchRad).toBeCloseTo(afterFrame.breathPitchRad, 10);
    expect(afterHitch.swayYawRad).toBeCloseTo(afterFrame.swayYawRad, 10);
    expect(Math.abs(afterHitch.breathPitchRad - before.breathPitchRad)).toBeLessThan(0.01);
  });

  it('breathes as a bounded pitch angle and a bob, never a scale', () => {
    const { frames } = run(9, 2000);
    const maxPitch = (SETTINGS.breath_amplitude_deg * Math.PI) / 180;
    for (const f of frames) {
      expect(Math.abs(f.breathPitchRad)).toBeLessThanOrEqual(maxPitch + 1e-9);
      expect(Math.abs(f.hipsBobM)).toBeLessThanOrEqual(SETTINGS.breath_amplitude_deg * 0.002 + 1e-9);
      expect(f).not.toHaveProperty('scale');
    }
    expect(Math.max(...frames.map((f) => f.breathPitchRad))).toBeGreaterThan(maxPitch * 0.9);
  });

  it('keeps the sway inside the configured amplitude', () => {
    const { frames } = run(13, 20000, 16);
    const maxYaw = (SETTINGS.sway_amplitude_deg * Math.PI) / 180;
    for (const f of frames) expect(Math.abs(f.swayYawRad)).toBeLessThanOrEqual(maxYaw + 1e-9);
    expect(Math.max(...frames.map((f) => Math.abs(f.swayYawRad)))).toBeGreaterThan(maxYaw * 0.8);
  });

  it('treats a blink timing of all zeros as no blinking, not a loop that never ends', () => {
    const zero = { ...SETTINGS, blink: { blink_min_interval: 0, blink_max_interval: 0, blink_close_duration: 0, blink_hold_duration: 0, blink_open_duration: 0 } };
    const { frames } = run(1, 200, 16, zero);
    expect(frames.every((f) => f.blinkWeight === 0 && f.blinkPhase === 'open')).toBe(true);
    // Zero durations with a real interval still terminate and still blink.
    const instant = { ...SETTINGS, blink: { ...SETTINGS.blink, blink_close_duration: 0, blink_hold_duration: 0, blink_open_duration: 0 } };
    expect(() => run(1, 2000, 16, instant)).not.toThrow();
  });

  it('takes a non-finite dt as a zero step', () => {
    const state = createIdleState(4, SETTINGS);
    const r = stepIdle(state, Number.NaN, SETTINGS);
    expect(r.state.tMs).toBe(0);
    expect(Number.isFinite(r.frame.breathPitchRad)).toBe(true);
    const again = stepIdle({ ...state, tMs: Number.NaN }, 16, SETTINGS);
    expect(again.state.tMs).toBe(16);
  });

  it('turns everything but the blink off when procedural is false', () => {
    const { frames } = run(9, 200, 16, { ...SETTINGS, procedural: false });
    for (const f of frames) {
      expect(f.breathPitchRad).toBe(0);
      expect(f.hipsBobM).toBe(0);
      expect(f.swayYawRad).toBe(0);
    }
  });

  it('drifts the gaze within a small cone and snaps to the camera under attention', () => {
    const { frames } = run(5, 3000);
    const drifted = frames.filter((f) => f.lookAt.mode === 'drift');
    expect(drifted.length).toBe(frames.length);
    for (const f of drifted) {
      if (f.lookAt.mode !== 'drift') continue;
      expect(Math.abs(f.lookAt.yawRad)).toBeLessThanOrEqual(0.35 + 1e-9);
      expect(Math.abs(f.lookAt.pitchRad)).toBeLessThanOrEqual(0.2 + 1e-9);
    }
    const looking = run(5, 10, 16, SETTINGS, true);
    expect(looking.frames.every((f) => f.lookAt.mode === 'camera')).toBe(true);
    const off = run(5, 10, 16, { ...SETTINGS, look_at: 'off' });
    expect(off.frames.every((f) => f.lookAt.mode === 'off')).toBe(true);
  });
});
