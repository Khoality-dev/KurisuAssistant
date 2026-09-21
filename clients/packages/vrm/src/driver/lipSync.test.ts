import { describe, expect, it } from 'vitest';
import { INITIAL_MOUTH, stepMouth, type MouthState } from './lipSync';

const settle = (amplitude: number, playing: boolean, frames: number, from: MouthState = INITIAL_MOUTH): MouthState => {
  let s = from;
  for (let i = 0; i < frames; i++) s = stepMouth(s, amplitude, playing, 16);
  return s;
};

describe('stepMouth', () => {
  it('is monotone in amplitude for a given previous state', () => {
    const prev = settle(0.5, true, 30);
    let last = -1;
    for (let a = 0; a <= 1.0001; a += 0.05) {
      const next = stepMouth(prev, a, true, 16).aa;
      expect(next).toBeGreaterThanOrEqual(last - 1e-12);
      last = next;
    }
  });

  it('is zero when not playing, whatever the amplitude says', () => {
    const open = settle(0.9, true, 40);
    expect(open.aa).toBeGreaterThan(0.5);
    const closed = settle(0.9, false, 60, open);
    expect(closed).toMatchObject({ aa: 0, ih: 0, ou: 0 });
  });

  it('releases more slowly than it attacks', () => {
    const rise = stepMouth(INITIAL_MOUTH, 1, true, 16).aa;
    const open = settle(1, true, 60);
    const fall = open.aa - stepMouth(open, 0, true, 16).aa;
    expect(rise).toBeGreaterThan(fall);
  });

  it('never exceeds the amplitude it is given', () => {
    const s = settle(0.6, true, 200);
    expect(s.aa).toBeLessThanOrEqual(0.6 + 1e-9);
    expect(s.ih).toBeLessThan(s.aa);
    expect(s.ou).toBeLessThan(s.aa);
  });

  it('reads a NaN amplitude as silence and recovers a poisoned state', () => {
    const open = settle(0.9, true, 40);
    const nan = stepMouth(open, Number.NaN, true, 16);
    expect(Number.isFinite(nan.aa)).toBe(true);
    expect(nan.aa).toBeLessThan(open.aa);
    const poisoned: MouthState = { aa: Number.NaN, ih: Number.NaN, ou: Number.NaN, phase: Number.NaN };
    const healed = settle(0.5, true, 30, poisoned);
    expect(Number.isFinite(healed.aa) && healed.aa > 0).toBe(true);
    expect(settle(0.9, false, 60, poisoned)).toMatchObject({ aa: 0, ih: 0, ou: 0 });
    expect(Number.isFinite(stepMouth(open, 0.5, true, Number.NaN).aa)).toBe(true);
  });

  it('clamps a wild amplitude into 0..1', () => {
    expect(settle(7, true, 100).aa).toBeLessThanOrEqual(1);
    expect(settle(-3, true, 100).aa).toBe(0);
  });
});
