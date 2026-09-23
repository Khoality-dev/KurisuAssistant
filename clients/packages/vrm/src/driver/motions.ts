/**
 * The built-in moves: wave, nod, think, bow, stretch, look around (#242).
 *
 * A model with no uploaded clip can still greet someone. Each move is a few
 * bone rotations written as a function of normalised time, faded in and out by
 * one envelope, so it starts and ends on whatever the procedural idle holds
 * and never snaps. Pure: no three.js and no DOM — the driver turns a frame
 * into rotations on the normalised rig (and conjugates them for a 0.x rig, as
 * it does every procedural rotation) and skips any bone a clip is animating.
 *
 * Rotations are in the VRM 1.0 rig's frame (the model faces +Z; +x on the
 * head pitches it forward). Arms: the rig's rest is a T-pose; the driver's
 * "lowered" pose is `rightUpperArm.z = +ARM_DROP_RAD`, so a raised right arm
 * is a negative z, and the left arm mirrors every z.
 */
import type { VrmMotion } from '@kurisu/models';

export type MotionBone =
  | 'head'
  | 'neck'
  | 'spine'
  | 'leftUpperArm'
  | 'leftLowerArm'
  | 'rightUpperArm'
  | 'rightLowerArm';

export const MOTION_BONES: readonly MotionBone[] = ['head', 'neck', 'spine', 'leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm'];

export type Euler3 = readonly [number, number, number];

export interface MotionFrame {
  /** 0..1: how far the move has taken over from the idle pose. */
  weight: number;
  /** The move's own rotation for each bone it uses, at full weight. */
  targets: Partial<Record<MotionBone, Euler3>>;
  /** The move has run its course; the driver drops it. */
  done: boolean;
}

/** How long each move lasts, ms. Also the reaction's shortest cooldown. */
export const MOTION_DURATION_MS: Record<VrmMotion, number> = {
  wave: 2200,
  nod: 1200,
  think: 2600,
  bow: 2000,
  stretch: 2400,
  look_around: 3000,
};

/** Fade in over the first 18 %, out over the last 22 %; smoothstepped so neither end snaps. */
export function motionEnvelope(p: number): number {
  if (!(p > 0) || p >= 1) return 0;
  const linear = Math.min(1, p / 0.18, (1 - p) / 0.22);
  return linear * linear * (3 - 2 * linear);
}

/**
 * Where a move is `elapsedMs` in. `armsLoweredZ` is the right upper arm's
 * resting z (the driver's lowered pose, or 0 when the arms stay in T-pose),
 * so the moves that keep an arm down keep it where the idle holds it.
 */
export function sampleMotion(motion: VrmMotion, elapsedMs: number, armsLoweredZ = 1.0): MotionFrame {
  const duration = MOTION_DURATION_MS[motion];
  const p = Math.max(0, elapsedMs) / duration;
  if (!(p < 1)) return { weight: 0, targets: {}, done: true };
  const weight = motionEnvelope(p);
  const t = Math.max(0, elapsedMs) / 1000;
  const down = armsLoweredZ;
  switch (motion) {
    case 'wave':
      // Right hand up beside the face, forearm swinging from the elbow.
      return {
        weight,
        done: false,
        targets: {
          rightUpperArm: [0, 0, -1.25],
          rightLowerArm: [0, 0, -0.9 + Math.sin(t * 13) * 0.4],
          head: [0, -0.06, 0.05],
        },
      };
    case 'nod':
      return { weight, done: false, targets: { head: [Math.sin(p * Math.PI * 4) * 0.2, 0, 0], neck: [0.04, 0, 0] } };
    case 'think':
      // Right hand to the chin, head tilted up and aside.
      return {
        weight,
        done: false,
        targets: {
          rightUpperArm: [0, -0.9, down * 0.9],
          rightLowerArm: [0, -2.0, 0],
          head: [-0.12, 0.2, 0.12],
        },
      };
    case 'bow':
      return { weight, done: false, targets: { spine: [0.42, 0, 0], head: [0.15, 0, 0] } };
    case 'stretch':
      // Both arms overhead, chest and head back.
      return {
        weight,
        done: false,
        targets: {
          rightUpperArm: [0, 0, -1.45],
          leftUpperArm: [0, 0, 1.45],
          rightLowerArm: [0, 0, -0.2],
          leftLowerArm: [0, 0, 0.2],
          spine: [-0.12, 0, 0],
          head: [-0.15, 0, 0],
        },
      };
    case 'look_around':
      return { weight, done: false, targets: { head: [0, Math.sin(p * Math.PI * 2) * 0.55, 0], neck: [0, Math.sin(p * Math.PI * 2) * 0.12, 0] } };
    default:
      return { weight: 0, targets: {}, done: true };
  }
}

/** `from` moved toward `to` by `w`, per axis. */
export function blendEuler(from: Euler3, to: Euler3, w: number): [number, number, number] {
  const k = Math.max(0, Math.min(1, w));
  return [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k, from[2] + (to[2] - from[2]) * k];
}
