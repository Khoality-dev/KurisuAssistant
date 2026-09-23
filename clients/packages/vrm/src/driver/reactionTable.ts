/**
 * Which reaction fires this frame, with the 2D graph's semantics carried over.
 *
 * A reaction's `when` is the same condition union the pose graph's edges use,
 * AND-ed; the first reaction whose conditions all hold wins; a condition of a
 * type this build does not know is false (so an older client stays inert, not
 * broken); a gesture is consumed by the tick that sees it. Two of the 2D
 * engine's habits need translating, because a reaction here changes no state
 * the way a transition changes node:
 *
 * - `thinking` and `face` are levels in the 2D engine, but a fire moves the
 *   character to another node, so an outgoing `thinking: true` edge fires once
 *   when thinking begins and the next node's `thinking: false` edge once when
 *   it ends. A reaction stays where it is, so the same conditions are read here
 *   as *edges*: `thinking: v` holds on the frame `isThinking` becomes `v`, and
 *   `face` on the frame the named face appears (`visible: true`) or goes
 *   (`visible: false`); a face named `*` is any face, so it holds when the
 *   first face appears and when the last one goes. The first frame seen only establishes the levels — a
 *   resting `thinking: false` reaction must not fire at startup — while a
 *   gesture or a due timer may fire from the first frame on.
 * - The 2D engine arms every `random` timer of a node's outgoing transitions
 *   on arrival, whatever else the transition asks for. So every `random`
 *   condition of every reaction is armed the first time the table is
 *   evaluated, not when evaluation happens to reach it, and re-armed when its
 *   reaction fires.
 *
 * Two things differ from the 2D engine on purpose: a `cooldown_ms` per
 * reaction, never shorter than what the reaction plays (a clip's length, an
 * expression's hold), so `cooldown_ms: 0` means "as soon as it is over" and
 * never "every frame"; and no re-evaluation in the same frame after a fire.
 * Pure: time and randomness come in as arguments.
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
  /** Last frame's levels, so `thinking` and `face` fire on the change, not the state. */
  prev: { isThinking: boolean; faces: string[] } | null;
}

export interface ReactionOptions {
  random?: () => number;
  /** The least a reaction may wait after firing: how long what it plays lasts. */
  minCooldownMs?: (reaction: VrmReaction) => number;
}

export const DEFAULT_COOLDOWN_MS = 4000;

export function createReactionTimers(): ReactionTimers {
  return { randomDueAt: {}, cooldownUntil: {}, prev: null };
}

function randomDue(c: Extract<TransitionCondition, { type: 'random' }>, nowMs: number, random: () => number): number {
  const lo = Math.max(0, Math.min(c.min_interval_ms, c.max_interval_ms));
  const hi = Math.max(lo, Math.max(c.min_interval_ms, c.max_interval_ms));
  return nowMs + lo + random() * (hi - lo);
}

function conditionHolds(
  reactionId: string,
  c: TransitionCondition,
  inputs: ReactionInputs,
  prev: { isThinking: boolean; faces: string[] } | null,
  nowMs: number,
  timers: ReactionTimers,
): boolean {
  switch (c.type) {
    case 'random': {
      const due = timers.randomDueAt[reactionId];
      return due != null && nowMs >= due;
    }
    case 'thinking':
      // An edge needs a previous level: on the first frame there is none.
      return prev != null && inputs.isThinking === c.value && prev.isThinking !== c.value;
    case 'gesture':
      return inputs.gestures.includes(c.value);
    case 'face': {
      if (!prev) return false;
      // `*` is any face at all — "smiles when you sit down" — named or not.
      const has = c.value === '*' ? inputs.faces.length > 0 : inputs.faces.includes(c.value);
      const had = c.value === '*' ? prev.faces.length > 0 : prev.faces.includes(c.value);
      return c.visible ? has && !had : !has && had;
    }
    default:
      return false;
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
  options: ReactionOptions | (() => number) = {},
): { fired: VrmReaction | null; timers: ReactionTimers } {
  const opts: ReactionOptions = typeof options === 'function' ? { random: options } : options;
  const random = opts.random ?? Math.random;

  // Arm every random timer the first time it is seen, whatever else its
  // reaction asks for — the 2D engine's `initEdgeTimers`.
  let randomDueAt = timers.randomDueAt;
  for (const r of reactions) {
    if (!r || !Array.isArray(r.when)) continue;
    const rnd = r.when.find((c) => c && c.type === 'random');
    if (rnd && rnd.type === 'random' && randomDueAt[r.id] == null) {
      randomDueAt = { ...randomDueAt, [r.id]: randomDue(rnd, nowMs, random) };
    }
  }

  // The first frame establishes the levels: a `thinking` or `face` edge
  // cannot hold on a state that was simply already so.
  const levels = { isThinking: inputs.isThinking, faces: [...inputs.faces] };
  const armed: ReactionTimers = { ...timers, randomDueAt };

  for (const r of reactions) {
    if (!r || !Array.isArray(r.when) || r.when.length === 0) continue;
    const until = armed.cooldownUntil[r.id];
    if (until != null && nowMs < until) continue;
    if (!r.when.every((c) => c && conditionHolds(r.id, c, inputs, timers.prev, nowMs, armed))) continue;

    const floor = Math.max(0, opts.minCooldownMs?.(r) ?? 0);
    const cooldown = Math.max(floor, Number.isFinite(r.cooldown_ms) ? Math.max(0, r.cooldown_ms) : DEFAULT_COOLDOWN_MS);
    const cooldownUntil = { ...armed.cooldownUntil, [r.id]: nowMs + cooldown };
    const rearmed = { ...armed.randomDueAt };
    const rnd = r.when.find((c) => c.type === 'random');
    if (rnd && rnd.type === 'random') rearmed[r.id] = randomDue(rnd, nowMs, random);
    return { fired: r, timers: { randomDueAt: rearmed, cooldownUntil, prev: levels } };
  }
  return { fired: null, timers: { ...armed, prev: levels } };
}
