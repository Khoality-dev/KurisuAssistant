/**
 * The setup editor's presets and recipes are only ever stored as plain idle
 * values and plain reactions, so the round trip is what matters: a preset
 * applied reads back as that preset, one changed number reads back as
 * "Custom", and a recipe switched on and off leaves every other reaction alone.
 */
import { describe, expect, it } from 'vitest';
import type { VrmReaction } from './character';
import {
  MOVE_PRESETS,
  REACTION_RECIPES,
  applyMovePreset,
  completeVrmSettings,
  defaultVrmSettings,
  derivePreset,
  emotionAvailability,
  extrasOn,
  recipeOn,
  resetVrmChoices,
  setExtras,
  setRecipe,
  strengthOf,
  toggleIdleClip,
  withoutClip,
} from './vrmSetup';

const base = () => defaultVrmSettings().idle;

describe('move presets', () => {
  it('the defaults read as Natural with its moves on', () => {
    expect(derivePreset(base())).toBe('natural');
    expect(extrasOn(base())).toBe(true);
  });

  it.each(MOVE_PRESETS.map((p) => p.id))('%s applied reads back as itself, with the moves on or off', (id) => {
    expect(derivePreset(applyMovePreset(base(), id, true))).toBe(id);
    expect(derivePreset(applyMovePreset(base(), id, false))).toBe(id);
  });

  it('one changed number is Custom', () => {
    const idle = { ...applyMovePreset(base(), 'calm'), sway_amplitude_deg: 3 };
    expect(derivePreset(idle)).toBe('custom');
  });

  it('a move list that is neither the preset’s nor empty is Custom', () => {
    expect(derivePreset({ ...base(), idle_motions: ['bow'] })).toBe('custom');
  });

  it('an absent move list is none, as the renderer reads a config older than the field', () => {
    const { idle_motions: _, ...rest } = base();
    expect(extrasOn(rest)).toBe(false);
    expect(derivePreset(rest)).toBe('natural');
  });

  it('applying a preset keeps the idle clips and the blink phase lengths', () => {
    const idle = { ...base(), idle_clip_ids: ['c1ip0001'], blink: { ...base().blink, blink_hold_duration: 80 } };
    const next = applyMovePreset(idle, 'lively');
    expect(next.idle_clip_ids).toEqual(['c1ip0001']);
    expect(next.blink.blink_hold_duration).toBe(80);
    expect(next.look_at).toBe('drift');
  });

  it('the extras switch returns to the preset’s own moves', () => {
    const lively = applyMovePreset(base(), 'lively', false);
    expect(extrasOn(lively)).toBe(false);
    expect(setExtras(lively, true).idle_motions).toEqual(['stretch', 'look_around', 'nod']);
    expect(setExtras({ ...lively, sway_amplitude_deg: 4 }, true).idle_motions).toEqual(['stretch', 'look_around']);
  });
});

describe('strength', () => {
  it('reads an intensity as the nearest of the three', () => {
    expect(strengthOf(0.5)).toBe('subtle');
    expect(strengthOf(0.8)).toBe('normal');
    expect(strengthOf(1)).toBe('strong');
    expect(strengthOf(0.62)).toBe('subtle');
    expect(strengthOf(0.95)).toBe('strong');
  });
});

describe('reaction recipes', () => {
  const custom: VrmReaction = {
    id: '0badf00d', name: 'mine', when: [{ type: 'thinking', value: false }], play: { type: 'motion', motion: 'bow' }, cooldown_ms: 1000,
  };

  it('the defaults are wave, think and greet', () => {
    const reactions = defaultVrmSettings().reactions;
    expect(REACTION_RECIPES.filter((r) => recipeOn(reactions, r.id)).map((r) => r.id)).toEqual(['wave', 'think', 'greet']);
  });

  it('greet fires on any face, wave on the wave gesture', () => {
    const greet = REACTION_RECIPES.find((r) => r.id === 'greet')!;
    expect(greet.reaction.when).toEqual([{ type: 'face', value: '*', visible: true }]);
    expect(greet.usesCamera).toBe(true);
    expect(REACTION_RECIPES.find((r) => r.id === 'think')!.usesCamera).toBe(false);
  });

  it('switching recipes leaves a hand-written reaction alone, after the recipes', () => {
    let reactions = [custom, ...defaultVrmSettings().reactions];
    reactions = setRecipe(reactions, 'peace', true);
    reactions = setRecipe(reactions, 'wave', false);
    expect(reactions.map((r) => r.id)).toEqual(['think', 'greet', 'peace', '0badf00d']);
    expect(reactions[3]).toBe(custom);
  });

  it('a recipe switched off and on again is the recipe, not a stale copy', () => {
    const off = setRecipe(defaultVrmSettings().reactions, 'think', false);
    const on = setRecipe(off, 'think', true);
    expect(on.find((r) => r.id === 'think')).toEqual(REACTION_RECIPES.find((r) => r.id === 'think')!.reaction);
  });
});

describe('settings helpers', () => {
  it('fills a partial stored member with the defaults', () => {
    const filled = completeVrmSettings({ idle: { breath_period_ms: 5000 } } as never);
    expect(filled.idle.breath_period_ms).toBe(5000);
    expect(filled.idle.blink.blink_min_interval).toBe(2000);
    expect(filled.idle.idle_motions).toEqual([]);
    expect(filled.camera.fov).toBe(24);
    expect(completeVrmSettings(null)).toEqual(defaultVrmSettings());
  });

  it('keeps an explicitly empty reaction list', () => {
    expect(completeVrmSettings({ reactions: [] }).reactions).toEqual([]);
  });

  it('reset keeps the model and her own animations', () => {
    const s = defaultVrmSettings();
    const clip = { id: 'c1ip0001', name: 'hop', url: '/character-assets/1/vrma/c1ip0001', sha256: 'b'.repeat(64), bytes: 1, loop: false };
    const edited = {
      ...s,
      clips: [clip],
      idle: { ...applyMovePreset(s.idle, 'still'), idle_clip_ids: ['c1ip0001'] },
      reactions: [],
      camera: { ...s.camera, target: 'head' as const },
    };
    const reset = resetVrmChoices(edited);
    expect(reset.clips).toEqual([clip]);
    expect(reset.idle.idle_clip_ids).toEqual(['c1ip0001']);
    expect(derivePreset(reset.idle)).toBe('natural');
    expect(reset.camera.target).toBe('upper_body');
    expect(reset.reactions.map((r) => r.id)).toEqual(['wave', 'think', 'greet']);
  });

  it('removes every reference to a clip before it is deleted', () => {
    const s = defaultVrmSettings();
    const clipReaction: VrmReaction = { id: 'r1', name: '', when: [], play: { type: 'clip', clip_id: 'c1ip0001' }, cooldown_ms: 0 };
    const with1 = toggleIdleClip({ ...s, reactions: [...s.reactions, clipReaction] }, 'c1ip0001');
    expect(with1.idle.idle_clip_ids).toEqual(['c1ip0001']);
    const without = withoutClip(with1, 'c1ip0001');
    expect(without.idle.idle_clip_ids).toEqual([]);
    expect(without.reactions.some((r) => r.id === 'r1')).toBe(false);
    expect(without.reactions).toHaveLength(3);
  });

  it('marks a face the model lacks', () => {
    const avail = emotionAvailability(['neutral', 'happy', 'angry', 'sad', 'relaxed']);
    expect(avail.surprised).toBe(false);
    expect(avail.happy).toBe(true);
    expect(emotionAvailability(undefined).surprised).toBe(true);
  });
});
