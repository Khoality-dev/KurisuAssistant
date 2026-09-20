/**
 * Everything a standing character does when nothing is happening.
 *
 * Breathing, sway, blinking and where the eyes rest — computed here as plain
 * numbers, applied to bones elsewhere. Two rules shaped it. Breathing is a
 * PITCH on the chest plus a bob of the hips, never a scale: three-vrm's
 * normalised rig copies rotations (and only the hips' position) onto the real
 * skeleton, so a scale written to a normalised bone renders nothing. And the
 * blink runs on the 2D rig's own timings (`BlinkTiming`), so a persona's two
 * characters blink alike. Deterministic for a seed; `dt` is clamped so a tab
 * that was hidden for a minute does not fling the spring bones on return.
 */
import type { BlinkTiming, VrmIdleSettings } from '@kurisu/models';

export type BlinkPhase = 'open' | 'closing' | 'held' | 'opening';

export interface BlinkState {
  phase: BlinkPhase;
  /** Time into the current phase, ms. */
  elapsedMs: number;
  /** While `open`: how long until the next blink starts. */
  untilNextMs: number;
}

export interface IdleState {
  /** Continuous idle time, ms; advances by the clamped dt. */
  tMs: number;
  blink: BlinkState;
  /** mulberry32 state — one number, so the whole state is a plain object. */
  rng: number;
  /** Where the eyes are drifting to and how far along, for `look_at: 'drift'`. */
  drift: { fromYaw: number; fromPitch: number; toYaw: number; toPitch: number; progress: number; untilNextMs: number };
}

export interface IdleFrame {
  /** Chest / upper chest pitch, radians (positive = chest forward). */
  breathPitchRad: number;
  /** Hips y offset, metres. */
  hipsBobM: number;
  swayYawRad: number;
  swayRollRad: number;
  /** 0 = eyes open, 1 = closed. */
  blinkWeight: number;
  blinkPhase: BlinkPhase;
  /** Where to look: the camera, an offset from it (radians), or nowhere. */
  lookAt: { mode: 'camera' } | { mode: 'drift'; yawRad: number; pitchRad: number } | { mode: 'off' };
}

export interface IdleInputs {
  /** Snaps a drifting gaze back to the camera: speaking, or a face in view. */
  attention: boolean;
}

/** The longest step the idle clocks accept, so a hitch is a pause, not a leap. */
export const MAX_IDLE_STEP_MS = 50;

const DEFAULT_BLINK: BlinkTiming = {
  blink_min_interval: 2000,
  blink_max_interval: 6000,
  blink_close_duration: 100,
  blink_hold_duration: 50,
  blink_open_duration: 100,
};

/** mulberry32: small, fast, and a single number of state. */
function nextRandom(state: number): { value: number; state: number } {
  let s = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, state: s };
}

function uniform(state: number, min: number, max: number): { value: number; state: number } {
  const r = nextRandom(state);
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return { value: lo + r.value * (hi - lo), state: r.state };
}

export function blinkTimingOf(settings: Pick<VrmIdleSettings, 'blink'> | null | undefined): BlinkTiming {
  return { ...DEFAULT_BLINK, ...(settings?.blink ?? {}) };
}

export function createIdleState(seed: number, settings: VrmIdleSettings): IdleState {
  const timing = blinkTimingOf(settings);
  const first = uniform(seed | 0 || 1, timing.blink_min_interval, timing.blink_max_interval);
  return {
    tMs: 0,
    blink: { phase: 'open', elapsedMs: 0, untilNextMs: first.value },
    rng: first.state,
    drift: { fromYaw: 0, fromPitch: 0, toYaw: 0, toPitch: 0, progress: 1, untilNextMs: 0 },
  };
}

function stepBlink(blink: BlinkState, rng: number, dt: number, timing: BlinkTiming): { blink: BlinkState; rng: number; weight: number } {
  let { phase, elapsedMs, untilNextMs } = blink;
  let remaining = dt;
  let state = rng;

  // Walk through phase boundaries so a 50 ms step never skips a 50 ms hold.
  while (remaining > 0) {
    if (phase === 'open') {
      if (remaining < untilNextMs) {
        untilNextMs -= remaining;
        remaining = 0;
      } else {
        remaining -= untilNextMs;
        untilNextMs = 0;
        phase = 'closing';
        elapsedMs = 0;
      }
      continue;
    }
    const length =
      phase === 'closing' ? timing.blink_close_duration
      : phase === 'held' ? timing.blink_hold_duration
      : timing.blink_open_duration;
    const left = length - elapsedMs;
    if (remaining < left) {
      elapsedMs += remaining;
      remaining = 0;
    } else {
      remaining -= left;
      if (phase === 'closing') { phase = 'held'; elapsedMs = 0; }
      else if (phase === 'held') { phase = 'opening'; elapsedMs = 0; }
      else {
        phase = 'open';
        elapsedMs = 0;
        const next = uniform(state, timing.blink_min_interval, timing.blink_max_interval);
        untilNextMs = next.value;
        state = next.state;
      }
    }
  }

  const weight =
    phase === 'open' ? 0
    : phase === 'held' ? 1
    : phase === 'closing' ? Math.min(1, elapsedMs / Math.max(1, timing.blink_close_duration))
    : 1 - Math.min(1, elapsedMs / Math.max(1, timing.blink_open_duration));
  return { blink: { phase, elapsedMs, untilNextMs }, rng: state, weight };
}

const DRIFT_MAX_YAW = 0.35;
const DRIFT_MAX_PITCH = 0.2;

function smoothstep(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

/**
 * One frame of idle motion. Returns the new state and what to apply.
 * `dtMs` is clamped to `MAX_IDLE_STEP_MS`.
 */
export function stepIdle(
  prev: IdleState,
  dtMs: number,
  settings: VrmIdleSettings,
  inputs: IdleInputs = { attention: false },
): { state: IdleState; frame: IdleFrame } {
  const dt = Math.min(Math.max(0, dtMs), MAX_IDLE_STEP_MS);
  const tMs = prev.tMs + dt;
  const timing = blinkTimingOf(settings);

  const b = stepBlink(prev.blink, prev.rng, dt, timing);
  let rng = b.rng;

  const procedural = settings.procedural !== false;
  const breathPeriod = Math.max(200, settings.breath_period_ms || 4000);
  const breathAmpRad = ((settings.breath_amplitude_deg ?? 2) * Math.PI) / 180;
  const swayPeriod = Math.max(500, settings.sway_period_ms || 7000);
  const swayAmpRad = ((settings.sway_amplitude_deg ?? 1.5) * Math.PI) / 180;

  const breath = Math.sin((2 * Math.PI * tMs) / breathPeriod);
  const breathPitchRad = procedural ? breathAmpRad * breath : 0;
  // 2 mm of bob per degree of chest pitch, in phase with the breath.
  const hipsBobM = procedural ? (settings.breath_amplitude_deg ?? 2) * 0.002 * breath : 0;
  const swayYawRad = procedural
    ? swayAmpRad * (Math.sin((2 * Math.PI * tMs) / swayPeriod) + 0.4 * Math.sin((2 * Math.PI * tMs) / (swayPeriod * 0.37) + 1))
    : 0;
  const swayRollRad = procedural ? 0.5 * swayAmpRad * Math.sin((2 * Math.PI * tMs) / (swayPeriod * 1.7)) : 0;

  // Gaze drift: a slow random walk within a small cone, snapped to the camera
  // while anything deserves attention.
  let drift = prev.drift;
  const mode = settings.look_at ?? 'camera';
  let lookAt: IdleFrame['lookAt'];
  if (mode === 'off') {
    lookAt = { mode: 'off' };
  } else if (mode === 'camera' || inputs.attention) {
    lookAt = { mode: 'camera' };
    if (mode === 'drift') drift = { ...drift, fromYaw: 0, fromPitch: 0, toYaw: 0, toPitch: 0, progress: 1 };
  } else {
    let { fromYaw, fromPitch, toYaw, toPitch, progress, untilNextMs } = drift;
    untilNextMs -= dt;
    if (untilNextMs <= 0) {
      const y = uniform(rng, -DRIFT_MAX_YAW, DRIFT_MAX_YAW);
      const p = uniform(y.state, -DRIFT_MAX_PITCH, DRIFT_MAX_PITCH);
      const wait = uniform(p.state, 2000, 5000);
      rng = wait.state;
      const s = smoothstep(progress);
      fromYaw = fromYaw + (toYaw - fromYaw) * s;
      fromPitch = fromPitch + (toPitch - fromPitch) * s;
      toYaw = y.value;
      toPitch = p.value;
      progress = 0;
      untilNextMs = wait.value;
    }
    progress = Math.min(1, progress + dt / 900);
    const s = smoothstep(progress);
    drift = { fromYaw, fromPitch, toYaw, toPitch, progress, untilNextMs };
    lookAt = { mode: 'drift', yawRad: fromYaw + (toYaw - fromYaw) * s, pitchRad: fromPitch + (toPitch - fromPitch) * s };
  }

  return {
    state: { tMs, blink: b.blink, rng, drift },
    frame: { breathPitchRad, hipsBobM, swayYawRad, swayRollRad, blinkWeight: b.weight, blinkPhase: b.blink.phase, lookAt },
  };
}
