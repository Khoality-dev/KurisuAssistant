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
 *
 * Two facts about three's mixer shape the slots. `clipAction` hands back one
 * action per (clip, root), so a clip that is both an idle and a reaction
 * would share an action and the one-shot would hijack the idle; the one-shot
 * slot therefore plays a clone of the clip. And an action that finishes with
 * `clampWhenFinished` off is disabled on the spot — before any listener's
 * `fadeOut` could run — so both slots clamp, and the fade-out is what the
 * `finished` listener starts and `update` finishes.
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
/** Below this an action's fade-out is over and it may be stopped. */
const FADED = 1e-3;

export interface PlayerOptions {
  random?: () => number;
}

interface Slot {
  loaded: LoadedClip;
  action: THREE.AnimationAction;
}

export class VrmaPlayer {
  private mixer: THREE.AnimationMixer;
  private clips = new Map<string, LoadedClip>();
  /** The one-shot slot's private copy of each clip, so its action is its own. */
  private oneShotCopies = new Map<string, THREE.AnimationClip>();
  private idle: Slot | null = null;
  /** A non-looping idle that ran to its end: its bones go back to the procedural idle until it is replayed. */
  private idleFinished = false;
  private oneShot: Slot | null = null;
  private oneShotFading = false;
  private untilNextIdleMs = 0;
  private random: () => number;

  constructor(vrm: VRM, options: PlayerOptions = {}) {
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.random = options.random ?? Math.random;
    this.mixer.addEventListener('finished', (e) => {
      if (this.oneShot && e.action === this.oneShot.action) this.beginOneShotFade();
      else if (this.idle && e.action === this.idle.action) this.idleFinished = true;
    });
  }

  add(loaded: LoadedClip): void {
    this.clips.set(loaded.ref.id, loaded);
  }

  has(clipId: string): boolean {
    return this.clips.has(clipId);
  }

  /** The clip's length, for the driver's minimum cooldown on a clip reaction. */
  durationMs(clipId: string): number | null {
    const loaded = this.clips.get(clipId);
    return loaded ? loaded.clip.duration * 1000 : null;
  }

  /** The bones and expressions currently owned by a clip, and whether the eyes are. */
  get authority(): { nodes: Set<string>; expressions: Set<string>; lookAt: boolean } {
    const nodes = new Set<string>();
    const expressions = new Set<string>();
    let lookAt = false;
    const owning: LoadedClip[] = [];
    if (this.idle && !this.idleFinished) owning.push(this.idle.loaded);
    if (this.oneShot) owning.push(this.oneShot.loaded);
    for (const c of owning) {
      c.animatedNodes.forEach((n) => nodes.add(n));
      c.animatedExpressions.forEach((n) => expressions.add(n));
      lookAt = lookAt || c.hasLookAt;
    }
    return { nodes, expressions, lookAt };
  }

  /** True from the reaction's first frame until its fade-out has completed. */
  get playingOneShot(): boolean {
    return this.oneShot !== null;
  }

  /** The reaction clip up right now, fading out included. */
  get oneShotClipId(): string | null {
    return this.oneShot?.loaded.ref.id ?? null;
  }

  /** Pick the next idle clip, or none when the list is empty or unknown. */
  private pickIdle(ids: string[]): LoadedClip | null {
    const known = ids.map((id) => this.clips.get(id)).filter((c): c is LoadedClip => !!c);
    if (!known.length) return null;
    if (known.length === 1) return known[0];
    // Never the same clip twice in a row when there is a choice.
    const candidates = known.filter((c) => c !== this.idle?.loaded);
    return candidates[Math.floor(this.random() * candidates.length)] ?? known[0];
  }

  /**
   * Advance the idle schedule: at the interval, cross-fade to another idle
   * clip — or replay the one there is, once it has run out. `intervalMs` is
   * `[min, max]`.
   */
  stepIdle(dtMs: number, idleIds: string[], intervalMs: [number, number]): void {
    if (!idleIds.length) {
      if (this.idle) {
        this.idle.action.fadeOut(IDLE_CROSSFADE_S);
        this.idle = null;
        this.idleFinished = false;
      }
      return;
    }
    this.untilNextIdleMs -= dtMs;
    if (this.idle && this.untilNextIdleMs > 0) return;
    const next = this.pickIdle(idleIds);
    if (!next) return;
    const [lo, hi] = intervalMs;
    this.untilNextIdleMs = Math.max(0, lo) + this.random() * Math.max(0, hi - lo);
    if (this.idle && next === this.idle.loaded) {
      if (this.idleFinished) {
        this.idle.action.reset().play();
        this.idleFinished = false;
      }
      return;
    }
    const action = this.mixer.clipAction(next.clip);
    action.reset();
    action.setLoop(next.ref.loop ? THREE.LoopRepeat : THREE.LoopOnce, next.ref.loop ? Infinity : 1);
    action.clampWhenFinished = true;
    action.enabled = true;
    if (this.idle) {
      // No warp: these are unrelated idles, not a walk and a run to phase-lock.
      action.crossFadeFrom(this.idle.action, IDLE_CROSSFADE_S, false);
    } else {
      action.fadeIn(IDLE_CROSSFADE_S);
    }
    action.play();
    this.idle = { loaded: next, action };
    this.idleFinished = false;
  }

  /** Play a reaction clip once over whatever is idling. Re-issuing the clip already up is a no-op. */
  playOneShot(clipId: string, crossfadeMs?: number): boolean {
    const loaded = this.clips.get(clipId);
    if (!loaded) return false;
    if (this.oneShot && this.oneShot.loaded === loaded && !this.oneShotFading) return true;
    if (this.oneShot) this.stopOneShot();
    const fade = (crossfadeMs ?? ONESHOT_FADE_S * 1000) / 1000;
    let copy = this.oneShotCopies.get(clipId);
    if (!copy) {
      copy = loaded.clip.clone();
      this.oneShotCopies.set(clipId, copy);
    }
    const action = this.mixer.clipAction(copy);
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.enabled = true;
    action.setEffectiveWeight(1);
    action.fadeIn(fade).play();
    this.oneShot = { loaded, action };
    this.oneShotFading = false;
    return true;
  }

  private beginOneShotFade(): void {
    if (!this.oneShot || this.oneShotFading) return;
    this.oneShotFading = true;
    this.oneShot.action.fadeOut(ONESHOT_FADE_S);
  }

  private stopOneShot(): void {
    if (!this.oneShot) return;
    this.oneShot.action.stop();
    this.oneShot = null;
    this.oneShotFading = false;
  }

  update(dtSeconds: number): void {
    this.mixer.update(dtSeconds);
    // The fade-out the `finished` listener started is over: only now do the
    // clip's bones go back to the procedural idle.
    if (this.oneShot && this.oneShotFading && this.oneShot.action.getEffectiveWeight() <= FADED) this.stopOneShot();
  }

  dispose(): void {
    this.mixer.stopAllAction();
    for (const c of this.clips.values()) this.mixer.uncacheClip(c.clip);
    for (const copy of this.oneShotCopies.values()) this.mixer.uncacheClip(copy);
    this.clips.clear();
    this.oneShotCopies.clear();
    this.idle = null;
    this.idleFinished = false;
    this.oneShot = null;
    this.oneShotFading = false;
  }
}
