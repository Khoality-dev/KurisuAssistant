import { describe, expect, it } from 'vitest';
import type { VrmReaction } from '@kurisu/models';
import { createReactionTimers, matchReactions, type ReactionInputs } from './reactionTable';

const QUIET: ReactionInputs = { isThinking: false, gestures: [], faces: [] };
const reaction = (id: string, when: VrmReaction['when'], cooldown = 4000): VrmReaction => ({
  id,
  name: id,
  when,
  play: { type: 'expression', expression: 'happy', weight: 1, hold_ms: 1000 },
  cooldown_ms: cooldown,
});

describe('matchReactions', () => {
  it('ANDs the conditions of one reaction', () => {
    const r = reaction('both', [{ type: 'gesture', value: 'wave' }, { type: 'face', value: 'Khoa', visible: true }]);
    expect(matchReactions([r], { ...QUIET, gestures: ['wave'] }, 0, createReactionTimers()).fired).toBeNull();
    expect(matchReactions([r], { ...QUIET, gestures: ['wave'], faces: ['Khoa'] }, 0, createReactionTimers()).fired?.id).toBe('both');
  });

  it('lets the first matching reaction win and fires one per call', () => {
    const a = reaction('a', [{ type: 'gesture', value: 'wave' }]);
    const b = reaction('b', [{ type: 'gesture', value: 'wave' }]);
    const res = matchReactions([a, b], { ...QUIET, gestures: ['wave'] }, 0, createReactionTimers());
    expect(res.fired?.id).toBe('a');
    expect(res.timers.cooldownUntil.b).toBeUndefined();
  });

  it('treats an unknown condition type as false', () => {
    const r = reaction('x', [{ type: 'weather', value: 'rain' } as never]);
    expect(matchReactions([r], QUIET, 0, createReactionTimers()).fired).toBeNull();
  });

  it('honours the cooldown', () => {
    const r = reaction('t', [{ type: 'thinking', value: true }], 4000);
    let timers = createReactionTimers();
    let res = matchReactions([r], { ...QUIET, isThinking: true }, 0, timers);
    expect(res.fired?.id).toBe('t');
    timers = res.timers;
    res = matchReactions([r], { ...QUIET, isThinking: true }, 3999, timers);
    expect(res.fired).toBeNull();
    res = matchReactions([r], { ...QUIET, isThinking: true }, 4000, res.timers);
    expect(res.fired?.id).toBe('t');
  });

  it('arms a random timer on first sight and re-arms it after firing', () => {
    const r = reaction('rnd', [{ type: 'random', min_interval_ms: 1000, max_interval_ms: 1000 }], 0);
    let res = matchReactions([r], QUIET, 100, createReactionTimers(), () => 0.5);
    expect(res.fired).toBeNull();
    expect(res.timers.randomDueAt.rnd).toBe(1100);
    res = matchReactions([r], QUIET, 1099, res.timers, () => 0.5);
    expect(res.fired).toBeNull();
    res = matchReactions([r], QUIET, 1100, res.timers, () => 0.5);
    expect(res.fired?.id).toBe('rnd');
    expect(res.timers.randomDueAt.rnd).toBe(2100);
  });

  it('matches a face condition either way round', () => {
    const present = reaction('p', [{ type: 'face', value: 'Khoa', visible: true }]);
    const absent = reaction('a', [{ type: 'face', value: 'Khoa', visible: false }]);
    expect(matchReactions([present, absent], { ...QUIET, faces: ['Khoa'] }, 0, createReactionTimers()).fired?.id).toBe('p');
    expect(matchReactions([present, absent], QUIET, 0, createReactionTimers()).fired?.id).toBe('a');
  });

  it('skips a reaction with no conditions', () => {
    expect(matchReactions([reaction('none', [])], QUIET, 0, createReactionTimers()).fired).toBeNull();
  });
});
