import { describe, expect, it } from 'vitest';
import { VRM_MOTIONS } from '@kurisu/models';
import { blendEuler, MOTION_DURATION_MS, motionEnvelope, sampleMotion } from './motions';

describe('the built-in moves', () => {
  it('fade in and out from zero, and hold full weight in the middle', () => {
    expect(motionEnvelope(0)).toBe(0);
    expect(motionEnvelope(1)).toBe(0);
    expect(motionEnvelope(0.5)).toBe(1);
    expect(motionEnvelope(0.09)).toBeGreaterThan(0);
    expect(motionEnvelope(0.09)).toBeLessThan(0.6);
    expect(motionEnvelope(NaN)).toBe(0);
  });

  it.each([...VRM_MOTIONS])('%s starts and ends on the idle pose and is done after its duration', (m) => {
    expect(sampleMotion(m, 0).weight).toBe(0);
    expect(sampleMotion(m, MOTION_DURATION_MS[m] / 2).weight).toBeGreaterThan(0.9);
    expect(Object.keys(sampleMotion(m, MOTION_DURATION_MS[m] / 2).targets).length).toBeGreaterThan(0);
    expect(sampleMotion(m, MOTION_DURATION_MS[m] - 1).weight).toBeLessThan(0.05);
    expect(sampleMotion(m, MOTION_DURATION_MS[m]).done).toBe(true);
  });

  it('never jumps between frames', () => {
    for (const m of VRM_MOTIONS) {
      let prev = 0;
      for (let t = 0; t < MOTION_DURATION_MS[m]; t += 16) {
        const w = sampleMotion(m, t).weight;
        expect(Math.abs(w - prev), `${m} at ${t} ms`).toBeLessThan(0.15);
        prev = w;
      }
    }
  });

  it('a wave raises the right arm above the shoulder line and leaves the left alone', () => {
    const f = sampleMotion('wave', 1100);
    expect(f.targets.rightUpperArm![2]).toBeLessThan(0);
    expect(f.targets.leftUpperArm).toBeUndefined();
  });

  it('a nod pitches the head and a look around turns it', () => {
    const nod = [0, 150, 300, 450].map((t) => sampleMotion('nod', 300 + t).targets.head![0]);
    expect(Math.max(...nod) - Math.min(...nod)).toBeGreaterThan(0.1);
    expect(Math.abs(sampleMotion('look_around', 750).targets.head![1])).toBeGreaterThan(0.4);
  });

  it('blends per axis and clamps the weight', () => {
    expect(blendEuler([0, 0, 1], [0, 0, -1], 0.5)).toEqual([0, 0, 0]);
    expect(blendEuler([0, 0, 1], [0, 0, -1], 2)).toEqual([0, 0, -1]);
    expect(blendEuler([0, 0, 1], [0, 0, -1], -1)).toEqual([0, 0, 1]);
  });
});
