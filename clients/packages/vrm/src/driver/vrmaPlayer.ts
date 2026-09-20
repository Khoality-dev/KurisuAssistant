/**
 * The clips: an idle slot and a one-shot slot on one mixer.
 *
 * Idle picks one of the configured clips at random every so often and
 * cross-fades to it; a reaction plays once on top, fading in and out, and
 * hands back to idle on `finished`. What a clip animates decides what the
 * procedural idle may touch: bones the clip drives are the clip's for its
 * duration, the rest stay procedural (design §6.6, "per-frame authority").
 * A clip with a look-at track also takes the eyes, so `lookAt.autoUpdate`
 * is off while it plays.
 */
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import type { VrmClipRef } from '@kurisu/models';
import { LOOK_AT_PROXY_NAME } from './loader';

export interface LoadedClip {
  ref: VrmClipRef;
  clip: THREE.AnimationClip;
  /** Node names (of normalised bones) the clip writes to. */
  animatedNodes: Set<string>;
  /** Preset/custom expression track names the clip writes to. */
  animatedExpressions: Set<string>;
  hasLookAt: boolean;
}

/** How three-vrm names the Object3D behind each expression, hence its track. */
export const EXPRESSION_PREFIX = 'VRMExpression_';

export function describeClip(ref: VrmClipRef, clip: THREE.AnimationClip): LoadedClip {
  const animatedNodes = new Set<string>();
  const animatedExpressions = new Set<string>();
  let hasLookAt = false;
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.');
    const target = dot >= 0 ? track.name.slice(0, dot) : track.name;
    const prop = dot >= 0 ? track.name.slice(dot + 1) : '';
    if (target === LOOK_AT_PROXY_NAME) { hasLookAt = true; continue; }
    // three-vrm names an expression track `VRMExpression_<name>.weight` (the
    // expression is an Object3D in the scene); bone tracks are
    // `<nodeName>.quaternion` / `.position`.
    if (prop === 'weight' && target.startsWith(EXPRESSION_PREFIX)) animatedExpressions.add(target.slice(EXPRESSION_PREFIX.length));
    else if (prop === 'quaternion' || prop === 'position' || prop === 'scale') animatedNodes.add(target);
  }
  return { ref, clip, animatedNodes, animatedExpressions, hasLookAt };
}

const IDLE_CROSSFADE_S = 0.3;
const ONESHOT_FADE_S = 0.25;

export interface PlayerOptions {
  random?: () => number;
}

export class VrmaPlayer {
  private mixer: THREE.AnimationMixer;
  private clips = new Map<string, LoadedClip>();
  private idleAction: THREE.AnimationAction | null = null;
  private idleClip: LoadedClip | null = null;
  private oneShotAction: THREE.AnimationAction | null = null;
  private oneShotClip: LoadedClip | null = null;
  private untilNextIdleMs = 0;
  private random: () => number;

  constructor(vrm: VRM, options: PlayerOptions = {}) {
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.random = options.random ?? Math.random;
    this.mixer.addEventListener('finished', (e) => {
      if (e.action === this.oneShotAction) this.endOneShot();
    });
  }

  add(loaded: LoadedClip): void {
    this.clips.set(loaded.ref.id, loaded);
  }

  has(clipId: string): boolean {
    return this.clips.has(clipId);
  }

  /** The bones and expressions currently owned by a clip, and whether the eyes are. */
  get authority(): { nodes: Set<string>; expressions: Set<string>; lookAt: boolean } {
    const nodes = new Set<string>();
    const expressions = new Set<string>();
    let lookAt = false;
    for (const c of [this.idleClip, this.oneShotClip]) {
      if (!c) continue;
      c.animatedNodes.forEach((n) => nodes.add(n));
      c.animatedExpressions.forEach((n) => expressions.add(n));
      lookAt = lookAt || c.hasLookAt;
    }
    return { nodes, expressions, lookAt };
  }

  get playingOneShot(): boolean {
    return this.oneShotClip !== null;
  }

  /** Pick the next idle clip, or none when the list is empty or unknown. */
  private pickIdle(ids: string[]): LoadedClip | null {
    const known = ids.map((id) => this.clips.get(id)).filter((c): c is LoadedClip => !!c);
    if (!known.length) return null;
    if (known.length === 1) return known[0];
    // Never the same clip twice in a row when there is a choice.
    const candidates = known.filter((c) => c !== this.idleClip);
    return candidates[Math.floor(this.random() * candidates.length)] ?? known[0];
  }

  /**
   * Advance the idle schedule: at the interval, cross-fade to another idle
   * clip. `intervalMs` is `[min, max]`.
   */
  stepIdle(dtMs: number, idleIds: string[], intervalMs: [number, number]): void {
    if (!idleIds.length) {
      if (this.idleAction) { this.idleAction.fadeOut(IDLE_CROSSFADE_S); this.idleAction = null; this.idleClip = null; }
      return;
    }
    this.untilNextIdleMs -= dtMs;
    if (this.idleAction && this.untilNextIdleMs > 0) return;
    const next = this.pickIdle(idleIds);
    if (!next) return;
    const [lo, hi] = intervalMs;
    this.untilNextIdleMs = Math.max(0, lo) + this.random() * Math.max(0, hi - lo);
    if (next === this.idleClip && this.idleAction) return;
    const action = this.mixer.clipAction(next.clip);
    action.reset();
    action.setLoop(next.ref.loop ? THREE.LoopRepeat : THREE.LoopOnce, next.ref.loop ? Infinity : 1);
    action.clampWhenFinished = !next.ref.loop;
    action.enabled = true;
    if (this.idleAction) {
      action.crossFadeFrom(this.idleAction, IDLE_CROSSFADE_S, true);
    }
    action.fadeIn(IDLE_CROSSFADE_S).play();
    this.idleAction = action;
    this.idleClip = next;
  }

  /** Play a reaction clip once over whatever is idling. */
  playOneShot(clipId: string, crossfadeMs?: number): boolean {
    const loaded = this.clips.get(clipId);
    if (!loaded) return false;
    if (this.oneShotAction) this.endOneShot();
    const fade = (crossfadeMs ?? ONESHOT_FADE_S * 1000) / 1000;
    const action = this.mixer.clipAction(loaded.clip);
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = false;
    action.enabled = true;
    action.setEffectiveWeight(1);
    action.fadeIn(fade).play();
    this.oneShotAction = action;
    this.oneShotClip = loaded;
    return true;
  }

  private endOneShot(): void {
    if (this.oneShotAction) this.oneShotAction.fadeOut(ONESHOT_FADE_S);
    this.oneShotAction = null;
    this.oneShotClip = null;
  }

  update(dtSeconds: number): void {
    this.mixer.update(dtSeconds);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    for (const c of this.clips.values()) this.mixer.uncacheClip(c.clip);
    this.clips.clear();
    this.idleAction = null;
    this.idleClip = null;
    this.oneShotAction = null;
    this.oneShotClip = null;
  }
}
