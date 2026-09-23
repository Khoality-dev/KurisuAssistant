import { describe, expect, it } from 'vitest';
import type { VrmReaction } from '@kurisu/models';
import { createReactionTimers, DEFAULT_COOLDOWN_MS, matchReactions, type ReactionInputs, type ReactionTimers } from './reactionTable';

const QUIET: ReactionInputs = { isThinking: false, gestures: [], faces: [] };
const reaction = (id: string, when: VrmReaction['when'], cooldown = 4000, play: VrmReaction['play'] = { type: 'expression', expression: 'happy', weight: 1, hold_ms: 1000 }): VrmReaction => ({
  id,
  name: id,
  when,
  play,
  cooldown_ms: cooldown,
});

/** Timers after one quiet frame: the levels are known, nothing has fired. */
function primed(reactions: VrmReaction[], inputs: ReactionInputs = QUIET, nowMs = 0): ReactionTimers {
  const res = matchReactions(reactions, inputs, nowMs, createReactionTimers(), () => 0.5);
  expect(res.fired).toBeNull();
  return res.timers;
}

describe('matchReactions', () => {
  it('fires no thinking or face reaction on the first frame, whatever the levels are', () => {
    const rs = [reaction('t', [{ type: 'thinking', value: true }]), reaction('f', [{ type: 'face', value: 'Khoa', visible: true }]), reaction('r', [{ type: 'thinking', value: false }])];
    const res = matchReactions(rs, { isThinking: true, gestures: [], faces: ['Khoa'] }, 0, createReactionTimers());
    expect(res.fired).toBeNull();
    expect(res.timers.prev).toEqual({ isThinking: true, faces: ['Khoa'] });
  });

  it('lets a gesture fire from the first frame', () => {
    const g = reaction('g', [{ type: 'gesture', value: 'wave' }]);
    expect(matchReactions([g], { ...QUIET, gestures: ['wave'] }, 0, createReactionTimers()).fired?.id).toBe('g');
  });

  it('ANDs the conditions of one reaction', () => {
    const r = reaction('both', [{ type: 'gesture', value: 'wave' }, { type: 'face', value: 'Khoa', visible: true }]);
    const timers = primed([r]);
    expect(matchReactions([r], { ...QUIET, gestures: ['wave'] }, 16, timers).fired).toBeNull();
    expect(matchReactions([r], { ...QUIET, gestures: ['wave'], faces: ['Khoa'] }, 16, timers).fired?.id).toBe('both');
  });

  it('lets the first matching reaction win and fires one per call', () => {
    const a = reaction('a', [{ type: 'gesture', value: 'wave' }]);
    const b = reaction('b', [{ type: 'gesture', value: 'wave' }]);
    const timers = primed([a, b]);
    const res = matchReactions([a, b], { ...QUIET, gestures: ['wave'] }, 16, timers);
    expect(res.fired?.id).toBe('a');
    expect(res.timers.cooldownUntil.b).toBeUndefined();
  });

  it('treats an unknown condition type as false', () => {
    const r = reaction('x', [{ type: 'weather', value: 'rain' } as never]);
    const timers = primed([r]);
    expect(matchReactions([r], QUIET, 16, timers).fired).toBeNull();
  });

  it('fires thinking on the change, not on the level, and honours the cooldown', () => {
    const r = reaction('t', [{ type: 'thinking', value: true }], 4000);
    let timers = primed([r]);
    let res = matchReactions([r], { ...QUIET, isThinking: true }, 16, timers);
    expect(res.fired?.id).toBe('t');
    timers = res.timers;
    // Still thinking: a level, not a change.
    res = matchReactions([r], { ...QUIET, isThinking: true }, 4100, timers);
    expect(res.fired).toBeNull();
    // Stops, then starts again inside the cooldown: nothing.
    res = matchReactions([r], QUIET, 4200, res.timers);
    res = matchReactions([r], { ...QUIET, isThinking: true }, 4015, res.timers);
    expect(res.fired).toBeNull();
    // Starts again after it: fires.
    res = matchReactions([r], QUIET, 4300, res.timers);
    res = matchReactions([r], { ...QUIET, isThinking: true }, 4400, res.timers);
    expect(res.fired?.id).toBe('t');
  });

  it('fires thinking: false once when thinking ends, never while resting', () => {
    const r = reaction('done', [{ type: 'thinking', value: false }], 0);
    let timers = primed([r]);
    for (let t = 16; t < 2000; t += 16) {
      const res = matchReactions([r], QUIET, t, timers);
      expect(res.fired).toBeNull();
      timers = res.timers;
    }
    timers = matchReactions([r], { ...QUIET, isThinking: true }, 2000, timers).timers;
    const res = matchReactions([r], QUIET, 2016, timers);
    expect(res.fired?.id).toBe('done');
  });

  it('arms every random timer on first sight, whatever else the reaction asks for', () => {
    const r = reaction('rnd', [{ type: 'gesture', value: 'wave' }, { type: 'random', min_interval_ms: 1000, max_interval_ms: 1000 }], 0);
    const timers = primed([r], QUIET, 100);
    expect(timers.randomDueAt.rnd).toBe(1100);
    // The gesture arrives before the timer is due: consumed for nothing, as in
    // the 2D engine; after the timer is due, the next gesture fires it.
    let res = matchReactions([r], { ...QUIET, gestures: ['wave'] }, 500, timers);
    expect(res.fired).toBeNull();
    res = matchReactions([r], { ...QUIET, gestures: ['wave'] }, 1100, res.timers);
    expect(res.fired?.id).toBe('rnd');
    expect(res.timers.randomDueAt.rnd).toBe(2100);
  });

  it('re-arms a random timer after firing', () => {
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

  it('matches a face on its arrival and on its departure', () => {
    const present = reaction('p', [{ type: 'face', value: 'Khoa', visible: true }]);
    const absent = reaction('a', [{ type: 'face', value: 'Khoa', visible: false }]);
    let timers = primed([present, absent]);
    expect(matchReactions([present, absent], QUIET, 16, timers).fired).toBeNull();
    let res = matchReactions([present, absent], { ...QUIET, faces: ['Khoa'] }, 32, timers);
    expect(res.fired?.id).toBe('p');
    timers = res.timers;
    res = matchReactions([present, absent], { ...QUIET, faces: ['Khoa'] }, 48, timers);
    expect(res.fired).toBeNull();
    res = matchReactions([present, absent], QUIET, 64, res.timers);
    expect(res.fired?.id).toBe('a');
  });

  it('reads a face named * as any face: the first to arrive and the last to go', () => {
    const anyone = reaction('any', [{ type: 'face', value: '*', visible: true }]);
    const nobody = reaction('none', [{ type: 'face', value: '*', visible: false }]);
    let res = matchReactions([anyone, nobody], { ...QUIET, faces: ['Unknown'] }, 16, primed([anyone, nobody]));
    expect(res.fired?.id).toBe('any');
    res = matchReactions([anyone, nobody], { ...QUIET, faces: ['Unknown', 'Khoa'] }, 32, res.timers);
    expect(res.fired).toBeNull();
    res = matchReactions([anyone, nobody], { ...QUIET, faces: ['Khoa'] }, 48, res.timers);
    expect(res.fired).toBeNull();
    res = matchReactions([anyone, nobody], QUIET, 64, res.timers);
    expect(res.fired?.id).toBe('none');
  });

  it('never fires more often than what it plays lasts, even with cooldown_ms 0', () => {
    const clip = reaction('c', [{ type: 'random', min_interval_ms: 0, max_interval_ms: 0 }], 0, { type: 'clip', clip_id: 'x' });
    const minCooldownMs = (r: VrmReaction) => (r.play.type === 'clip' ? 500 : r.play.type === 'expression' ? r.play.hold_ms ?? 0 : 0);
    let timers = createReactionTimers();
    let fires = 0;
    for (let t = 16; t <= 1600; t += 16) {
      const res = matchReactions([clip], QUIET, t, timers, { random: () => 0, minCooldownMs });
      if (res.fired) fires++;
      timers = res.timers;
    }
    // At 16, 528, 1040 and 1552 ms: never inside the 500 ms the clip plays for.
    expect(fires).toBe(4);
  });

  it('falls back to the default cooldown when cooldown_ms is not a number', () => {
    const r = reaction('g', [{ type: 'gesture', value: 'wave' }], Number.NaN);
    const timers = primed([r]);
    const res = matchReactions([r], { ...QUIET, gestures: ['wave'] }, 16, timers);
    expect(res.timers.cooldownUntil.g).toBe(16 + DEFAULT_COOLDOWN_MS);
  });

  it('skips a reaction with no conditions', () => {
    const timers = primed([reaction('none', [])]);
    expect(matchReactions([reaction('none', [])], QUIET, 16, timers).fired).toBeNull();
  });
});
