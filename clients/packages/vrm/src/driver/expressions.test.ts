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
const QUIET: ExpressionInputs = { cue: null, isThinking: false, isPlaying: false, blinkBusy: false };

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
      const w = appliedWeights(s, SETTINGS, QUIET);
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
    const w = appliedWeights(s, SETTINGS, QUIET, vrm0);
    expect(w.surprised).toBe(0);
    expect(w.neutral).toBeCloseTo(1, 5);
  });

  it('caps an overrideMouth expression while speech plays, and lifts the cap after', () => {
    const model: ExpressionModel = { ...FULL_MODEL, overrideMouth: { ...everyEmotion<'none' | 'block' | 'blend'>('none'), happy: 'block' } };
    let s = createExpressionState(SETTINGS, model);
    s = advance(s, { ...QUIET, cue: { emotion: 'happy', hold_ms: 9000 } }, 400, SETTINGS, model);
    expect(appliedWeights(s, SETTINGS, { isPlaying: true, blinkBusy: false }, model).happy).toBeCloseTo(OVERRIDE_CAP, 5);
    expect(appliedWeights(s, SETTINGS, { isPlaying: false, blinkBusy: false }, model).happy).toBeCloseTo(1, 5);
  });

  it('caps an overrideBlink expression while the eyelids are busy', () => {
    const model: ExpressionModel = { ...FULL_MODEL, overrideBlink: { ...everyEmotion<'none' | 'block' | 'blend'>('none'), sad: 'blend' } };
    let s = createExpressionState(SETTINGS, model);
    s = advance(s, { ...QUIET, cue: { emotion: 'sad', hold_ms: 9000 } }, 400, SETTINGS, model);
    expect(appliedWeights(s, SETTINGS, { isPlaying: false, blinkBusy: true }, model).sad).toBeCloseTo(OVERRIDE_CAP, 5);
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
    expect(appliedWeights(s, { ...SETTINGS, intensity: 0.4 }, QUIET).happy).toBeCloseTo(0.4, 5);
  });

  it('ignores cues and the thinking face when the channel is disabled', () => {
    let s = createExpressionState({ ...SETTINGS, enabled: false });
    s = advance(s, { ...QUIET, isThinking: true, cue: { emotion: 'happy', hold_ms: 5000 } }, 400, { ...SETTINGS, enabled: false });
    expect(s.current.source).toBe('rest');
    expect(s.weights.happy).toBe(0);
  });
});
