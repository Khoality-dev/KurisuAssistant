/**
 * One persona's VRM character behind the `CharacterDriver` contract.
 *
 * The surface owns the box, the clock and the feed; this owns the model.
 * `load` fetches the model and its clips through the host's `resolveAsset`
 * (so it never sees a token), `update` runs the per-frame authority order —
 * clip → procedural idle for the bones the clip leaves alone → look-at →
 * expressions → `vrm.update` → render — and `dispose` lets go of everything
 * it holds. The renderer and the two loaders are injectable, which is what
 * lets the whole stage run headless under happy-dom against fakes: the
 * three.js scene graph, mixer and quaternion maths all run without a GPU.
 *
 * Two frames. three-vrm builds a model's normalised rig in the model's own
 * root frame, and a VRM 0.x model faces -Z where a 1.0 model faces +Z;
 * `VRMUtils.rotateVRM0` turns the whole scene by π about Y but the rig's
 * axes stay the model's, so a rotation written to a normalised bone means
 * the opposite thing about X and Z on a 0.x rig. three-vrm's own retargeting
 * negates a clip's quaternion x and z for `metaVersion === '0'`; every
 * procedural rotation here goes through the same conjugation.
 */
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { createVRMAnimationClip } from '@pixiv/three-vrm-animation';
import type {
  CharacterDriver,
  DriverInput,
  DriverLoadDeps,
  EmotionCue,
  ParsedCharacterConfig,
  VrmEmotion,
  VrmEmotionSettings,
  VrmIdleSettings,
  VrmReaction,
  VrmSettings,
} from '@kurisu/models';
import { VRM_EMOTIONS } from '@kurisu/models';
import { INITIAL_MOUTH, stepMouth, type MouthState } from './lipSync';
import { createIdleState, stepIdle, type IdleFrame, type IdleState } from './idle';
import {
  appliedWeights,
  createExpressionState,
  stepExpressions,
  type ExpressionModel,
  type ExpressionState,
} from './expressions';
import { createReactionTimers, matchReactions, type ReactionTimers } from './reactionTable';
import {
  acquireModel,
  loadVrmClip,
  loadVrmModel,
  modelCacheKey,
  releaseModel,
  VrmLoadError,
  type ClipLoader,
  type LoadedModel,
  type ModelLoader,
  type ModelOwner,
  type VrmMetaSummary,
} from './loader';
import { createStage, defaultRendererFactory, frameCamera, resizeStage, type RendererFactory, type Stage } from './scene';
import { describeClip, VrmaPlayer } from './vrmaPlayer';

export interface VrmDriverOptions {
  rendererFactory?: RendererFactory;
  modelLoader?: ModelLoader;
  clipLoader?: ClipLoader;
  /** Wall clock, for reaction timers; `Date.now` unless a test says otherwise. */
  now?: () => number;
  /** `Math.random` unless a test says otherwise. */
  random?: () => number;
  /** Seed for the idle clocks; a test passes a constant. */
  seed?: number;
  /**
   * Force the canvas's WebGL context lost on `dispose`. Off by default: the
   * driver does not own the canvas, a lost context stays lost for whatever
   * draws on that canvas next, and `renderer.dispose` already returns the
   * driver's own GPU resources. The surface turns this on only when the
   * canvas is leaving the document with the driver.
   */
  releaseContextOnDispose?: boolean;
}

/** What the surface may read off a driver beyond the contract: the model-info card's facts, and a test's view. */
export interface VrmDriverInfo {
  /** Present once `load` resolved. */
  readonly model: { meta: VrmMetaSummary; expressions: ExpressionModel } | null;
  /** The last frame's outputs; for tests and the editor's preview overlay. */
  snapshot(): VrmFrameSnapshot;
}

export interface VrmFrameSnapshot {
  loaded: boolean;
  mouth: MouthState;
  blinkWeight: number;
  expressions: Record<VrmEmotion, number>;
  lookAtAutoUpdate: boolean | null;
  oneShotPlaying: boolean;
  lastReactionId: string | null;
  /** How many reactions have fired since the model was loaded. */
  reactionsFired: number;
  /** Normalised bone nodes a clip owned in the last frame. */
  ownedNodes: string[];
  framesDrawn: number;
}

export type VrmDriver = CharacterDriver & VrmDriverInfo;

const DEFAULT_IDLE: VrmIdleSettings = {
  procedural: true,
  arms_lowered: true,
  breath_period_ms: 4000,
  breath_amplitude_deg: 2,
  sway_amplitude_deg: 1.5,
  sway_period_ms: 7000,
  blink: { blink_min_interval: 2000, blink_max_interval: 6000, blink_close_duration: 100, blink_hold_duration: 50, blink_open_duration: 100 },
  look_at: 'camera',
  idle_clip_ids: [],
  idle_clip_interval_ms: [8000, 20000],
};

const DEFAULT_EMOTION: VrmEmotionSettings = {
  enabled: true,
  default_expression: 'neutral',
  intensity: 1,
  attack_ms: 180,
  release_ms: 400,
  thinking: null,
};

/** The longest frame the animation accepts, so a backgrounded tab returns without a leap. */
const MAX_FRAME_MS = 50;
export const ARM_DROP_RAD = 1.0;
export const FOREARM_BEND_RAD = 0.12;

type Bone = Parameters<VRM['humanoid']['getNormalizedBoneNode']>[0];

function abortError(): Error {
  const e = new Error('The character load was abandoned.');
  e.name = 'AbortError';
  return e;
}

export function createVrmDriver(canvas: HTMLCanvasElement, options: VrmDriverOptions = {}): VrmDriver {
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const modelLoader = options.modelLoader ?? loadVrmModel;
  const clipLoader = options.clipLoader ?? loadVrmClip;
  /** This driver's claim on a cached model instance. */
  const owner: ModelOwner = Symbol('vrm-driver');

  let stage: Stage | null = null;
  let disposed = false;
  let loadGeneration = 0;
  let framesDrawn = 0;

  // Everything below is per loaded model, cleared by `unload`.
  let loaded: LoadedModel | null = null;
  let loadedKey: string | null = null;
  /** The cache key this driver has a claim on, from the moment a load asks for it. */
  let claimedKey: string | null = null;
  let settings: VrmSettings | null = null;
  let player: VrmaPlayer | null = null;
  let idleSettings = DEFAULT_IDLE;
  let emotionSettings = DEFAULT_EMOTION;
  let reactions: VrmReaction[] = [];
  let mouth: MouthState = INITIAL_MOUTH;
  let idle: IdleState = createIdleState(options.seed ?? 1, DEFAULT_IDLE);
  let expressions: ExpressionState = createExpressionState(DEFAULT_EMOTION);
  let timers: ReactionTimers = createReactionTimers();
  let hipsRestY = 0;
  let driftTarget: THREE.Object3D | null = null;
  let lastFrame: IdleFrame | null = null;
  let lastApplied: Record<VrmEmotion, number> = Object.fromEntries(VRM_EMOTIONS.map((e) => [e, 0])) as Record<VrmEmotion, number>;
  let lastReactionId: string | null = null;
  let reactionsFired = 0;
  let lastOwnedNodes: string[] = [];
  let lastLookMode: IdleFrame['lookAt']['mode'] | null = null;

  function ensureStage(): Stage {
    if (!stage) stage = createStage(canvas, options.rendererFactory ?? defaultRendererFactory, settings?.camera);
    return stage;
  }

  /** Put a shared model back the way the cache handed it out: rest pose, no expressions, eyes ahead. */
  function resetModel(model: LoadedModel): void {
    model.vrm.humanoid.resetNormalizedPose();
    model.vrm.expressionManager?.resetValues();
    if (model.vrm.lookAt) {
      model.vrm.lookAt.reset();
      model.vrm.lookAt.target = null;
      model.vrm.lookAt.autoUpdate = true;
    }
  }

  function unload(): void {
    if (player) player.dispose();
    player = null;
    if (loaded) {
      resetModel(loaded);
      if (stage) stage.scene.remove(loaded.vrm.scene);
    }
    if (loadedKey) {
      releaseModel(loadedKey, owner);
      if (claimedKey === loadedKey) claimedKey = null;
    }
    if (driftTarget && stage) stage.scene.remove(driftTarget);
    driftTarget = null;
    loaded = null;
    loadedKey = null;
    settings = null;
    lastFrame = null;
    lastReactionId = null;
    reactionsFired = 0;
    lastOwnedNodes = [];
    lastLookMode = null;
    mouth = INITIAL_MOUTH;
  }

  function bone(name: Bone): THREE.Object3D | null {
    return loaded?.vrm.humanoid.getNormalizedBoneNode(name) ?? null;
  }

  /** A rotation in the rig's frame: on a 0.x rig, x and z mean the opposite. */
  function setRotation(node: THREE.Object3D, x: number, y: number, z: number): void {
    if (loaded?.meta.metaVersion === '0') node.rotation.set(-x, y, -z);
    else node.rotation.set(x, y, z);
  }

  function lowerArms(owned: Set<string>): void {
    if (!idleSettings.arms_lowered) return;
    const pairs: Array<[Bone, number]> = [
      ['leftUpperArm', -ARM_DROP_RAD],
      ['rightUpperArm', ARM_DROP_RAD],
      ['leftLowerArm', -FOREARM_BEND_RAD],
      ['rightLowerArm', FOREARM_BEND_RAD],
    ];
    for (const [name, z] of pairs) {
      const node = bone(name);
      if (!node || owned.has(node.name)) continue;
      setRotation(node, 0, 0, z);
    }
  }

  function applyIdle(frame: IdleFrame, owned: Set<string>): void {
    const chest = bone('chest');
    const upper = bone('upperChest');
    const hips = bone('hips');
    if (chest && !owned.has(chest.name)) setRotation(chest, frame.breathPitchRad, 0, 0);
    if (upper && !owned.has(upper.name)) setRotation(upper, frame.breathPitchRad * 0.5, 0, 0);
    if (hips && !owned.has(hips.name)) {
      setRotation(hips, 0, frame.swayYawRad, frame.swayRollRad);
      hips.position.y = hipsRestY + frame.hipsBobM;
    }
  }

  function applyLookAt(frame: IdleFrame, clipOwnsEyes: boolean): void {
    const st = stage;
    const lookAt = loaded?.vrm.lookAt;
    if (!st || !lookAt) return;
    if (clipOwnsEyes) {
      lookAt.autoUpdate = false;
      return;
    }
    lookAt.autoUpdate = true;
    const mode = frame.lookAt.mode;
    if (mode === 'off') {
      // `update` only recomputes the eyes while there is a target: entering
      // `off` has to put them back to straight ahead itself, once.
      if (lastLookMode !== 'off') lookAt.reset();
      lastLookMode = 'off';
      lookAt.target = null;
      return;
    }
    lastLookMode = mode;
    if (mode === 'camera') {
      lookAt.target = st.gazeTarget;
      return;
    }
    if (!driftTarget) {
      driftTarget = new THREE.Object3D();
      driftTarget.name = 'gaze-drift';
      st.scene.add(driftTarget);
    }
    const head = bone('head');
    const headPos = new THREE.Vector3();
    if (head) head.getWorldPosition(headPos);
    const camPos = new THREE.Vector3();
    st.camera.getWorldPosition(camPos);
    const d = Math.max(0.3, camPos.distanceTo(headPos));
    driftTarget.position.set(
      camPos.x + Math.sin(frame.lookAt.yawRad) * d,
      camPos.y + Math.sin(frame.lookAt.pitchRad) * d,
      camPos.z,
    );
    lookAt.target = driftTarget;
  }

  function applyExpressions(dt: number, input: DriverInput, frame: IdleFrame, ownedExpressions: Set<string>, cue: EmotionCue | null): void {
    const manager = loaded?.vrm.expressionManager;
    if (!manager || !loaded) return;
    expressions = stepExpressions(
      expressions,
      { cue, isThinking: input.isThinking, isPlaying: input.isPlaying },
      emotionSettings,
      dt,
      loaded.expressions,
    );
    lastApplied = appliedWeights(expressions, emotionSettings, loaded.expressions);
    for (const e of VRM_EMOTIONS) {
      if (ownedExpressions.has(e) || !loaded.expressions.available[e]) continue;
      manager.setValue(e, lastApplied[e]);
    }
    if (!ownedExpressions.has('aa')) manager.setValue('aa', mouth.aa);
    if (!ownedExpressions.has('ih')) manager.setValue('ih', mouth.ih);
    if (!ownedExpressions.has('ou')) manager.setValue('ou', mouth.ou);
    if (!ownedExpressions.has('blink')) manager.setValue('blink', frame.blinkWeight);
  }

  /** The least a reaction may rest after firing: as long as what it plays. */
  function minCooldownMs(r: VrmReaction): number {
    if (r.play.type === 'clip') return player?.durationMs(r.play.clip_id) ?? 0;
    return Math.max(0, r.play.hold_ms ?? 0);
  }

  const driver: VrmDriver = {
    kind: 'vrm',

    get model() {
      return loaded ? { meta: loaded.meta, expressions: loaded.expressions } : null;
    },

    async load(config: ParsedCharacterConfig, deps: DriverLoadDeps): Promise<void> {
      if (disposed) throw new Error('This character driver was disposed.');
      const generation = ++loadGeneration;
      const current = () => !disposed && generation === loadGeneration;

      // A load that is refused leaves the driver empty, not holding the
      // previous persona: what was there goes before anything is checked.
      unload();
      if (deps.signal.aborted) throw abortError();
      if (config.kind !== 'vrm' || !config.vrm) throw new VrmLoadError('This persona does not use a 3D character.');
      const vrmSettings = config.vrm;
      if (!vrmSettings.model) throw new VrmLoadError('This persona has no 3D model yet. Upload one in its settings.');
      const st = ensureStage();

      const key = modelCacheKey(vrmSettings.model.url, vrmSettings.model.sha256);
      // One claim at a time: a load superseded before it landed may still hold
      // a claim on another key, which nobody else will release.
      if (claimedKey && claimedKey !== key) releaseModel(claimedKey, owner);
      claimedKey = key;
      // Only the load that owns the claim may drop it; a superseded one leaves
      // it to its successor, which may be holding the very same instance.
      const dropClaim = () => {
        if (current() && claimedKey === key) {
          releaseModel(key, owner);
          claimedKey = null;
        }
      };

      let model: LoadedModel;
      try {
        model = await acquireModel(
          key,
          owner,
          async () => modelLoader(await deps.resolveAsset(vrmSettings.model!.url), vrmSettings.model!.url),
          deps.signal,
        );
      } catch (error) {
        dropClaim();
        throw error;
      }
      if (deps.signal.aborted || !current()) {
        dropClaim();
        throw abortError();
      }

      const clipsLoaded: Array<ReturnType<typeof describeClip>> = [];
      try {
        for (const ref of vrmSettings.clips ?? []) {
          const bytes = await deps.resolveAsset(ref.url);
          if (deps.signal.aborted || !current()) throw abortError();
          const animation = await clipLoader(bytes, ref.url);
          if (deps.signal.aborted || !current()) throw abortError();
          clipsLoaded.push(describeClip(ref, createVRMAnimationClip(animation, model.vrm)));
        }
      } catch (error) {
        dropClaim();
        throw error;
      }

      resetModel(model);
      loaded = model;
      loadedKey = key;
      settings = vrmSettings;
      idleSettings = { ...DEFAULT_IDLE, ...(vrmSettings.idle ?? {}) };
      emotionSettings = { ...DEFAULT_EMOTION, ...(vrmSettings.emotion ?? {}) };
      reactions = Array.isArray(vrmSettings.reactions) ? vrmSettings.reactions : [];
      idle = createIdleState(options.seed ?? (now() | 0), idleSettings);
      expressions = createExpressionState(emotionSettings, model.expressions);
      timers = createReactionTimers();
      mouth = INITIAL_MOUTH;

      st.scene.add(model.vrm.scene);
      // The rest height comes from the rig's rest pose, never the live bone:
      // a cached model's hips carry the last frame's breathing bob.
      hipsRestY = model.vrm.humanoid.normalizedRestPose.hips?.position?.[1] ?? bone('hips')?.position.y ?? 0;
      player = new VrmaPlayer(model.vrm, { random });
      for (const c of clipsLoaded) player.add(c);

      st.scene.background = new THREE.Color(vrmSettings.camera?.background || '#ffffff');
      frameCamera(st, model.vrm, vrmSettings.camera);
      lowerArms(new Set());
      model.vrm.update(0);
    },

    update(dtMs: number, input: DriverInput): void {
      if (disposed || !loaded || !stage || !player) return;
      const dt = Number.isFinite(dtMs) ? Math.min(Math.max(0, dtMs), MAX_FRAME_MS) : 0;
      const t = now();

      // 1. Reactions: at most one fires per frame; gestures are consumed by this update.
      let cue: EmotionCue | null = input.cue;
      const matched = matchReactions(
        reactions,
        { isThinking: input.isThinking, gestures: input.gestures, faces: input.faces },
        t,
        timers,
        { random, minCooldownMs },
      );
      timers = matched.timers;
      if (matched.fired) {
        lastReactionId = matched.fired.id;
        reactionsFired++;
        const play = matched.fired.play;
        if (play.type === 'clip') player.playOneShot(play.clip_id, play.crossfade_ms);
        else if (!cue) cue = { emotion: play.expression, weight: play.weight, hold_ms: play.hold_ms };
      }

      // 2. Clips advance first; they own what they animate for this frame.
      player.stepIdle(dt, idleSettings.idle_clip_ids ?? [], idleSettings.idle_clip_interval_ms ?? [8000, 20000]);
      player.update(dt / 1000);
      const owned = player.authority;
      lastOwnedNodes = [...owned.nodes];

      // 3. Procedural idle for the rest of the body.
      const attention = input.isPlaying || input.faces.length > 0;
      const stepped = stepIdle(idle, dt, idleSettings, { attention });
      idle = stepped.state;
      lastFrame = stepped.frame;
      lowerArms(owned.nodes);
      applyIdle(stepped.frame, owned.nodes);

      // 4. Eyes.
      applyLookAt(stepped.frame, owned.lookAt);

      // 5. Face: mouth, blink, feeling.
      mouth = stepMouth(mouth, input.amplitude, input.isPlaying, dt);
      applyExpressions(dt, input, stepped.frame, owned.expressions, cue);

      // 6. The model updates itself (spring bones, look-at, expression binds), then draws.
      loaded.vrm.update(dt / 1000);
      stage.renderer.render(stage.scene, stage.camera);
      framesDrawn++;
    },

    resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
      if (disposed) return;
      const st = ensureStage();
      resizeStage(st, cssWidth, cssHeight, devicePixelRatio);
      if (loaded) frameCamera(st, loaded.vrm, settings?.camera);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      loadGeneration++;
      unload();
      if (claimedKey) {
        releaseModel(claimedKey, owner);
        claimedKey = null;
      }
      if (stage) {
        stage.renderer.dispose();
        if (options.releaseContextOnDispose) stage.renderer.forceContextLoss?.();
        stage = null;
      }
    },

    snapshot(): VrmFrameSnapshot {
      return {
        loaded: !!loaded,
        mouth,
        blinkWeight: lastFrame?.blinkWeight ?? 0,
        expressions: { ...lastApplied },
        lookAtAutoUpdate: loaded?.vrm.lookAt ? loaded.vrm.lookAt.autoUpdate : null,
        oneShotPlaying: player?.playingOneShot ?? false,
        lastReactionId,
        reactionsFired,
        ownedNodes: [...lastOwnedNodes],
        framesDrawn,
      };
    },
  };

  return driver;
}
