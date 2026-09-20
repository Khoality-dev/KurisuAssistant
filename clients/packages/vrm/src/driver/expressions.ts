/**
 * The face: which preset expression is up, how strongly, and for how long.
 *
 * A cue (from the emotion channel, or a reaction) names a preset; this module
 * ramps it in over `attack_ms`, holds it, and releases it toward the resting
 * face over `release_ms`, cross-fading when the next cue arrives early. Three
 * facts about VRM shape the rest. Presets are additive and over-driving tears
 * the face, so the non-neutral weights are clamped to sum to one. A VRM 0.x
 * model has no `surprised` at all and `setValue` on a missing preset is a
 * silent no-op, so a cue for a preset the model lacks degrades to neutral.
 * And an expression may declare `overrideMouth`/`overrideBlink`, which
 * three-vrm honours by subtracting from the mouth and blink weights — a happy
 * face exported with `overrideMouth: block` would mute lip sync for its whole
 * hold, so such an expression is capped while the mouth or the eyelids are
 * busy. Pure: the model's table is read once at load and passed in.
 */
import type { EmotionCue, VrmEmotion, VrmEmotionSettings } from '@kurisu/models';
import { VRM_EMOTIONS } from '@kurisu/models';

export type OverrideMode = 'none' | 'block' | 'blend';

/** What the loaded model actually exposes, read once at load. */
export interface ExpressionModel {
  available: Record<VrmEmotion, boolean>;
  overrideMouth: Record<VrmEmotion, OverrideMode>;
  overrideBlink: Record<VrmEmotion, OverrideMode>;
}

export interface ExpressionState {
  /** Envelope weight per preset, 0..1, before intensity and caps. */
  weights: Record<VrmEmotion, number>;
  /** The preset currently held up, and why. */
  current: { emotion: VrmEmotion; weight: number; holdRemainingMs: number | null; source: 'cue' | 'thinking' | 'rest' };
  /** Whether speech was playing last frame — a held cue releases on its falling edge. */
  wasPlaying: boolean;
}

export interface ExpressionInputs {
  cue: EmotionCue | null;
  isThinking: boolean;
  isPlaying: boolean;
  /** The blink is closing or closed, so a `overrideBlink` expression is capped. */
  blinkBusy: boolean;
}

/** The cap on an expression that would otherwise mute the mouth or the eyelids. */
export const OVERRIDE_CAP = 0.6;

const ALL: readonly VrmEmotion[] = VRM_EMOTIONS;

export function everyEmotion<T>(value: T): Record<VrmEmotion, T> {
  const out = {} as Record<VrmEmotion, T>;
  for (const e of ALL) out[e] = value;
  return out;
}

/** A model that exposes every preset and overrides nothing — the VRM 1.0 default. */
export const FULL_MODEL: ExpressionModel = {
  available: everyEmotion(true),
  overrideMouth: everyEmotion<OverrideMode>('none'),
  overrideBlink: everyEmotion<OverrideMode>('none'),
};

function restingOf(settings: VrmEmotionSettings, model: ExpressionModel): VrmEmotion {
  const rest = settings.default_expression ?? 'neutral';
  return model.available[rest] ? rest : 'neutral';
}

export function createExpressionState(settings: VrmEmotionSettings, model: ExpressionModel = FULL_MODEL): ExpressionState {
  const rest = restingOf(settings, model);
  const weights = everyEmotion(0);
  weights[rest] = 1;
  return { weights, current: { emotion: rest, weight: 1, holdRemainingMs: null, source: 'rest' }, wasPlaying: false };
}

/** A cue for a preset the model lacks becomes neutral, so the wire set never shrinks. */
export function degrade(emotion: VrmEmotion, model: ExpressionModel): VrmEmotion {
  return model.available[emotion] ? emotion : 'neutral';
}

/**
 * One frame. Decides what is up (a new cue outranks everything; a held cue
 * outranks the thinking face; the thinking face outranks rest), then moves
 * every preset's envelope toward its target.
 */
export function stepExpressions(
  prev: ExpressionState,
  inputs: ExpressionInputs,
  settings: VrmEmotionSettings,
  dtMs: number,
  model: ExpressionModel = FULL_MODEL,
): ExpressionState {
  const dt = Math.max(0, dtMs);
  const rest = restingOf(settings, model);
  const enabled = settings.enabled !== false;
  let current = { ...prev.current };

  if (enabled && inputs.cue) {
    current = {
      emotion: degrade(inputs.cue.emotion, model),
      weight: Math.max(0, Math.min(1, inputs.cue.weight ?? 1)),
      holdRemainingMs: inputs.cue.hold_ms ?? null,
      source: 'cue',
    };
  } else if (current.source === 'cue') {
    if (current.holdRemainingMs != null) {
      current.holdRemainingMs -= dt;
      if (current.holdRemainingMs <= 0) current = { emotion: rest, weight: 1, holdRemainingMs: null, source: 'rest' };
    } else if (prev.wasPlaying && !inputs.isPlaying) {
      // Speech ended: the held feeling lets go.
      current = { emotion: rest, weight: 1, holdRemainingMs: null, source: 'rest' };
    }
  }

  if (current.source !== 'cue') {
    const thinking = enabled && inputs.isThinking && settings.thinking ? degrade(settings.thinking, model) : null;
    current = thinking
      ? { emotion: thinking, weight: 1, holdRemainingMs: null, source: 'thinking' }
      : { emotion: rest, weight: 1, holdRemainingMs: null, source: 'rest' };
  }

  // Envelopes: the current preset rises at the attack rate, every other falls
  // at the release rate. A cue arriving mid-release therefore cross-fades.
  const attack = Math.max(1, settings.attack_ms ?? 180);
  const release = Math.max(1, settings.release_ms ?? 400);
  const weights = everyEmotion(0);
  for (const e of ALL) {
    const target = e === current.emotion ? current.weight : 0;
    const w = prev.weights[e] ?? 0;
    const rate = target > w ? dt / attack : dt / release;
    const next = target > w ? Math.min(target, w + rate) : Math.max(target, w - rate);
    weights[e] = next;
  }

  return { weights, current, wasPlaying: inputs.isPlaying };
}

/**
 * The weights to hand to the model this frame: intensity applied, overriding
 * expressions capped while the mouth or eyelids need their channel, and the
 * non-neutral sum clamped to one. Neutral takes whatever is left.
 */
export function appliedWeights(
  state: ExpressionState,
  settings: VrmEmotionSettings,
  inputs: Pick<ExpressionInputs, 'isPlaying' | 'blinkBusy'>,
  model: ExpressionModel = FULL_MODEL,
): Record<VrmEmotion, number> {
  const intensity = Math.max(0, Math.min(1, settings.intensity ?? 1));
  const out = everyEmotion(0);
  let sum = 0;
  for (const e of ALL) {
    if (e === 'neutral' || !model.available[e]) continue;
    let w = state.weights[e] * intensity;
    if (inputs.isPlaying && model.overrideMouth[e] !== 'none') w = Math.min(w, OVERRIDE_CAP);
    if (inputs.blinkBusy && model.overrideBlink[e] !== 'none') w = Math.min(w, OVERRIDE_CAP);
    out[e] = w;
    sum += w;
  }
  if (sum > 1) {
    for (const e of ALL) if (e !== 'neutral') out[e] /= sum;
    sum = 1;
  }
  out.neutral = model.available.neutral ? Math.max(0, 1 - sum) : 0;
  return out;
}
