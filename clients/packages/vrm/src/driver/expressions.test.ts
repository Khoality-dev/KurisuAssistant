import { describe, expect, it } from 'vitest';
import type { VrmEmotion, VrmEmotionSettings } from '@kurisu/models';
import { VRM_EMOTIONS } from '@kurisu/models';
import {
  appliedWeights,
  createExpressionState,
  everyEmotion,
  FULL_MODEL,
  OVERRIDE_CAP,
  stepExpressions,
  type ExpressionInputs,
  type ExpressionModel,
  type ExpressionState,
} from './expressions';

const SETTINGS: VrmEmotionSettings = { enabled: true, default_expression: 'neutral', intensity: 1, attack_ms: 180, release_ms: 400, thinking: 'relaxed' };
const QUIET: ExpressionInputs = { cue: null, isThinking: false, isPlaying: false };

function advance(state: ExpressionState, inputs: ExpressionInputs, ms: number, settings = SETTINGS, model = FULL_MODEL): ExpressionState {
  let s = state;
  for (let t = 0; t < ms; t += 16) s = stepExpressions(s, t === 0 ? inputs : { ...inputs, cue: null }, settings, 16, model);
  return s;
}

const nonNeutralSum = (w: Record<VrmEmotion, number>) => VRM_EMOTIONS.filter((e) => e !== 'neutral').reduce((a, e) => a + w[e], 0);

describe('stepExpressions', () => {
  it('ramps a cue in over attack_ms and holds it', () => {
    let s = createExpressionState(SETTINGS);
    s = advance(s, { ...QUIET, cue: { emotion: 'happy', hold_ms: 5000 } }, 200);
    expect(s.weights.happy).toBeCloseTo(1, 1);
    expect(s.current.emotion).toBe('happy');
  });

  it('cross-fades to the next cue without the non-neutral sum exceeding one', () => {
    let s = createExpressionState(SETTINGS);
    s = advance(s, { ...QUIET, cue: { emotion: 'happy', hold_ms: 5000 } }, 300);
    s = stepExpressions(s, { ...QUIET, cue: { emotion: 'sad', hold_ms: 5000 } }, SETTINGS, 16);
    for (let i = 0; i < 40; i++) {
      s = stepExpressions(s, QUIET, SETTINGS, 16);
      const w = appliedWeights(s, SETTINGS);
      expect(nonNeutralSum(w)).toBeLessThanOrEqual(1 + 1e-9);
      expect(w.neutral).toBeGreaterThanOrEqual(0);
    }
    expect(s.weights.sad).toBeGreaterThan(s.weights.happy);
  });

  it('returns to the resting face after hold + release', () => {
    let s = createExpressionState({ ...SETTINGS, default_expression: 'relaxed' });
    s = advance(s, { ...QUIET, cue: { emotion: 'angry', hold_ms: 500 } }, 200);
    expect(s.weights.angry).toBeGreaterThan(0.9);
    s = advance(s, QUIET, 500 + 400 + 100, { ...SETTINGS, default_expression: 'relaxed' });
    expect(s.weights.angry).toBe(0);
    expect(s.weights.relaxed).toBeCloseTo(1, 1);
    expect(s.current.source).toBe('rest');
  });

  it('holds a cue without a hold until speech ends', () => {
    let s = createExpressionState(SETTINGS);
    const speaking = { ...QUIET, isPlaying: true };
    s = advance(s, { ...speaking, cue: { emotion: 'surprised' } }, 3000);
    expect(s.current.emotion).toBe('surprised');
    s = stepExpressions(s, QUIET, SETTINGS, 16);
    expect(s.current.source).toBe('rest');
  });

  it('degrades a preset the model lacks to neutral', () => {
    const vrm0: ExpressionModel = { ...FULL_MODEL, available: { ...everyEmotion(true), surprised: false } };
    let s = createExpressionState(SETTINGS, vrm0);
    s = advance(s, { ...QUIET, cue: { emotion: 'surprised', hold_ms: 5000 } }, 300, SETTINGS, vrm0);
    expect(s.current.emotion).toBe('neutral');
    expect(s.weights.surprised).toBe(0);
    const w = appliedWeights(s, SETTINGS, vrm0);
    expect(w.surprised).toBe(0);
    expect(w.neutral).toBeCloseTo(1, 5);
  });

  it('drives an overrideMouth: block expression to zero while speech plays, and lifts it after', () => {
    // three-vrm mutes the mouth entirely for `block` at any weight above zero,
    // so the only weight that keeps lip sync alive is none at all.
    const model: ExpressionModel = { ...FULL_MODEL, overrideMouth: { ...everyEmotion<'none' | 'block' | 'blend'>('none'), happy: 'block' } };
    let s = createExpressionState(SETTINGS, model);
    s = advance(s, { ...QUIET, cue: { emotion: 'happy', hold_ms: 9000 } }, 400, SETTINGS, model);
    expect(appliedWeights(s, SETTINGS, model).happy).toBeCloseTo(1, 5);
    s = advance(s, { ...QUIET, isPlaying: true }, 600, SETTINGS, model);
    expect(appliedWeights(s, SETTINGS, model).happy).toBe(0);
    s = advance(s, QUIET, 400, SETTINGS, model);
    expect(appliedWeights(s, SETTINGS, model).happy).toBeCloseTo(1, 5);
  });

  it('caps an overrideMouth: blend expression at OVERRIDE_CAP while speech plays', () => {
    const model: ExpressionModel = { ...FULL_MODEL, overrideMouth: { ...everyEmotion<'none' | 'block' | 'blend'>('none'), happy: 'blend' } };
    let s = createExpressionState(SETTINGS, model);
    s = advance(s, { ...QUIET, cue: { emotion: 'happy', hold_ms: 9000 } }, 400, SETTINGS, model);
    s = advance(s, { ...QUIET, isPlaying: true }, 600, SETTINGS, model);
    expect(appliedWeights(s, SETTINGS, model).happy).toBeCloseTo(OVERRIDE_CAP, 5);
  });

  it('ramps the cap through the envelope instead of popping', () => {
    const model: ExpressionModel = { ...FULL_MODEL, overrideMouth: { ...everyEmotion<'none' | 'block' | 'blend'>('none'), happy: 'block' } };
    let s = createExpressionState(SETTINGS, model);
    s = advance(s, { ...QUIET, cue: { emotion: 'happy', hold_ms: 9000 } }, 400, SETTINGS, model);
    const before = s.weights.happy;
    s = stepExpressions(s, { ...QUIET, isPlaying: true }, SETTINGS, 16, model);
    // One frame of release at 400 ms: at most 16/400 of the way down.
    expect(before - s.weights.happy).toBeCloseTo(16 / 400, 5);
    expect(s.weights.happy).toBeGreaterThan(0.9);
  });

  it('caps an overrideBlink: blend expression for as long as it is up, and leaves block to the model', () => {
    // A per-blink cap would ramp the whole face every two to six seconds;
    // a constant cap keeps some blink, and `block` is the author's choice.
    const model: ExpressionModel = {
      ...FULL_MODEL,
      overrideBlink: { ...everyEmotion<'none' | 'block' | 'blend'>('none'), sad: 'blend', angry: 'block' },
    };
    let s = createExpressionState(SETTINGS, model);
    s = advance(s, { ...QUIET, cue: { emotion: 'sad', hold_ms: 9000 } }, 400, SETTINGS, model);
    expect(appliedWeights(s, SETTINGS, model).sad).toBeCloseTo(OVERRIDE_CAP, 5);
    s = createExpressionState(SETTINGS, model);
    s = advance(s, { ...QUIET, cue: { emotion: 'angry', hold_ms: 9000 } }, 400, SETTINGS, model);
    expect(appliedWeights(s, SETTINGS, model).angry).toBeCloseTo(1, 5);
  });

  it('treats a non-finite dt or a poisoned weight as zero', () => {
    let s = createExpressionState(SETTINGS);
    s = stepExpressions({ ...s, weights: { ...s.weights, happy: Number.NaN } }, { ...QUIET, cue: { emotion: 'happy', hold_ms: 100 } }, SETTINGS, Number.NaN);
    for (const w of Object.values(s.weights)) expect(Number.isFinite(w)).toBe(true);
  });

  it('shows the thinking face while thinking and lets a cue outrank it', () => {
    let s = createExpressionState(SETTINGS);
    s = advance(s, { ...QUIET, isThinking: true }, 400);
    expect(s.current).toMatchObject({ emotion: 'relaxed', source: 'thinking' });
    s = advance(s, { ...QUIET, isThinking: true, cue: { emotion: 'happy', hold_ms: 2000 } }, 400);
    expect(s.current).toMatchObject({ emotion: 'happy', source: 'cue' });
  });

  it('scales every weight by intensity', () => {
    let s = createExpressionState(SETTINGS);
    s = advance(s, { ...QUIET, cue: { emotion: 'happy', hold_ms: 5000 } }, 400);
    expect(appliedWeights(s, { ...SETTINGS, intensity: 0.4 }).happy).toBeCloseTo(0.4, 5);
  });

  it('ignores cues and the thinking face when the channel is disabled', () => {
    let s = createExpressionState({ ...SETTINGS, enabled: false });
    s = advance(s, { ...QUIET, isThinking: true, cue: { emotion: 'happy', hold_ms: 5000 } }, 400, { ...SETTINGS, enabled: false });
    expect(s.current.source).toBe('rest');
    expect(s.weights.happy).toBe(0);
  });
});
