/**
 * Which reaction fires this frame, with the 2D graph's semantics verbatim.
 *
 * A reaction's `when` is the same condition union the pose graph's edges use,
 * AND-ed; the first reaction whose conditions all hold wins; a condition of a
 * type this build does not know is false (so an older client stays inert, not
 * broken); a `random` condition is a timer keyed by the reaction's id, armed
 * on first sight and re-armed after firing; a gesture is consumed by the tick
 * that sees it. Two things differ from the 2D engine on purpose: a
 * `cooldown_ms` per reaction, because `thinking` and `face` are level state
 * and `open_palm` and `wave` can co-fire in one frame; and no re-evaluation in
 * the same frame after a fire. Pure: time and randomness come in as arguments.
 */
import type { TransitionCondition, VrmReaction } from '@kurisu/models';

export interface ReactionInputs {
  isThinking: boolean;
  gestures: string[];
  faces: string[];
}

export interface ReactionTimers {
  /** Absolute ms at which each `random` reaction next fires, keyed by reaction id. */
  randomDueAt: Record<string, number>;
  /** Absolute ms before which a reaction may not fire again, keyed by reaction id. */
  cooldownUntil: Record<string, number>;
}

export const DEFAULT_COOLDOWN_MS = 4000;

export function createReactionTimers(): ReactionTimers {
  return { randomDueAt: {}, cooldownUntil: {} };
}

function conditionHolds(
  reactionId: string,
  c: TransitionCondition,
  inputs: ReactionInputs,
  nowMs: number,
  timers: ReactionTimers,
  random: () => number,
): { holds: boolean; timers: ReactionTimers } {
  switch (c.type) {
    case 'random': {
      const due = timers.randomDueAt[reactionId];
      if (due == null) {
        const lo = Math.max(0, Math.min(c.min_interval_ms, c.max_interval_ms));
        const hi = Math.max(c.min_interval_ms, c.max_interval_ms);
        return { holds: false, timers: { ...timers, randomDueAt: { ...timers.randomDueAt, [reactionId]: nowMs + lo + random() * (hi - lo) } } };
      }
      return { holds: nowMs >= due, timers };
    }
    case 'thinking':
      return { holds: inputs.isThinking === c.value, timers };
    case 'gesture':
      return { holds: inputs.gestures.includes(c.value), timers };
    case 'face': {
      const has = inputs.faces.includes(c.value);
      return { holds: c.visible ? has : !has, timers };
    }
    default:
      return { holds: false, timers };
  }
}

/**
 * The one reaction that fires now, if any, and the timers to carry to the
 * next frame. A fired `random` reaction is re-armed; every fired reaction
 * starts its cooldown.
 */
export function matchReactions(
  reactions: readonly VrmReaction[],
  inputs: ReactionInputs,
  nowMs: number,
  timers: ReactionTimers,
  random: () => number = Math.random,
): { fired: VrmReaction | null; timers: ReactionTimers } {
  let t = timers;
  for (const r of reactions) {
    if (!r || !Array.isArray(r.when) || r.when.length === 0) continue;
    const until = t.cooldownUntil[r.id];
    if (until != null && nowMs < until) continue;
    let all = true;
    for (const c of r.when) {
      const res = conditionHolds(r.id, c, inputs, nowMs, t, random);
      t = res.timers;
      if (!res.holds) { all = false; break; }
    }
    if (!all) continue;

    const cooldown = Math.max(0, r.cooldown_ms ?? DEFAULT_COOLDOWN_MS);
    const cooldownUntil = { ...t.cooldownUntil, [r.id]: nowMs + cooldown };
    const randomDueAt = { ...t.randomDueAt };
    const rnd = r.when.find((c) => c.type === 'random');
    if (rnd && rnd.type === 'random') {
      const lo = Math.max(0, Math.min(rnd.min_interval_ms, rnd.max_interval_ms));
      const hi = Math.max(rnd.min_interval_ms, rnd.max_interval_ms);
      randomDueAt[r.id] = nowMs + lo + random() * (hi - lo);
    }
    return { fired: r, timers: { randomDueAt, cooldownUntil } };
  }
  return { fired: null, timers: t };
}
