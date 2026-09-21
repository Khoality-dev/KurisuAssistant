/**
 * Mouth shapes from one number.
 *
 * The only speech signal that exists is an RMS amplitude, 0..1, per ~33 ms
 * window (`POST /tts` returns WAV bytes, no phonemes, no timings). The 2D rig
 * maps that straight onto two sprites and it reads fine at two frames; on a
 * continuous blendshape the same stepped number chatters, so the value is
 * smoothed with a fast attack (consonant onsets stay crisp) and a slower
 * release (the jaw does not flap shut between syllables), and a slow
 * modulation moves some of the opening into `ih`/`ou` so the mouth reads as
 * speech rather than a hinge. Pure: no three, no DOM, so it is testable in CI.
 */

export interface MouthState {
  aa: number;
  ih: number;
  ou: number;
  /** Radians; advances while speaking so the ih/ou wobble is continuous. */
  phase: number;
}

export interface LipSyncOptions {
  attackMs?: number;
  releaseMs?: number;
}

export const INITIAL_MOUTH: MouthState = { aa: 0, ih: 0, ou: 0, phase: 0 };

const DEFAULT_ATTACK_MS = 40;
const DEFAULT_RELEASE_MS = 90;
/** Below this the mouth is closed, so a silent tail settles to exact zeros. */
const CLOSED = 1e-3;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * One frame of lip sync. Monotone in `amplitude` for a given previous state,
 * zero when not playing, release slower than attack.
 */
export function stepMouth(
  prev: MouthState,
  amplitude: number,
  isPlaying: boolean,
  dtMs: number,
  options: LipSyncOptions = {},
): MouthState {
  const attack = options.attackMs ?? DEFAULT_ATTACK_MS;
  const release = options.releaseMs ?? DEFAULT_RELEASE_MS;
  // A NaN from a missing curve window must not poison the state for good:
  // it reads as silence, and a poisoned previous state reads as closed.
  const dt = Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0;
  const prevAa = Number.isFinite(prev.aa) ? prev.aa : 0;
  const prevPhase = Number.isFinite(prev.phase) ? prev.phase : 0;
  const target = isPlaying && Number.isFinite(amplitude) ? clamp01(amplitude) : 0;
  const tau = target > prevAa ? attack : release;
  const k = tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
  let aa = prevAa + (target - prevAa) * k;

  if (!isPlaying && aa < CLOSED) {
    return { aa: 0, ih: 0, ou: 0, phase: prevPhase };
  }

  // A slow, deterministic wobble: two incommensurate rates so it never settles
  // into a visible loop. Only ever a fraction of `aa`, so the total opening is
  // still what the amplitude says.
  const phase = prevPhase + (dt / 1000) * (2 * Math.PI * 0.9) * (0.6 + 0.8 * aa);
  const ih = aa * 0.35 * (0.5 + 0.5 * Math.sin(phase));
  const ou = aa * 0.25 * (0.5 + 0.5 * Math.sin(phase * 0.61 + 1.3));
  aa = clamp01(aa);
  return { aa, ih: clamp01(ih), ou: clamp01(ou), phase };
}
