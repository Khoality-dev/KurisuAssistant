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
  cachedModel,
  loadVrmClip,
  loadVrmModel,
  modelCacheKey,
  VrmLoadError,
  type ClipLoader,
  type LoadedModel,
  type ModelLoader,
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
const ARM_DROP_RAD = 1.0;
const FOREARM_BEND_RAD = 0.12;

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

  let stage: Stage | null = null;
  let disposed = false;
  let loadGeneration = 0;

  // Everything below is per loaded model, cleared by `unload`.
  let loaded: LoadedModel | null = null;
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

  function ensureStage(): Stage {
    if (!stage) stage = createStage(canvas, options.rendererFactory ?? defaultRendererFactory, settings?.camera);
    return stage;
  }

  function unload(): void {
    if (player) player.dispose();
    player = null;
    if (loaded && stage) stage.scene.remove(loaded.vrm.scene);
    if (driftTarget && stage) stage.scene.remove(driftTarget);
    driftTarget = null;
    loaded = null;
    settings = null;
    lastFrame = null;
    lastReactionId = null;
    mouth = INITIAL_MOUTH;
  }

  function bone(name: Bone): THREE.Object3D | null {
    return loaded?.vrm.humanoid.getNormalizedBoneNode(name) ?? null;
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
      node.rotation.set(0, 0, z);
    }
  }

  function applyIdle(frame: IdleFrame, owned: Set<string>): void {
    const chest = bone('chest');
    const upper = bone('upperChest');
    const hips = bone('hips');
    if (chest && !owned.has(chest.name)) chest.rotation.set(frame.breathPitchRad, 0, 0);
    if (upper && !owned.has(upper.name)) upper.rotation.set(frame.breathPitchRad * 0.5, 0, 0);
    if (hips && !owned.has(hips.name)) {
      hips.rotation.set(0, frame.swayYawRad, frame.swayRollRad);
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
    if (frame.lookAt.mode === 'off') {
      lookAt.target = null;
      return;
    }
    if (frame.lookAt.mode === 'camera') {
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
    const blinkBusy = frame.blinkPhase !== 'open';
    expressions = stepExpressions(
      expressions,
      { cue, isThinking: input.isThinking, isPlaying: input.isPlaying, blinkBusy },
      emotionSettings,
      dt,
      loaded.expressions,
    );
    lastApplied = appliedWeights(expressions, emotionSettings, { isPlaying: input.isPlaying, blinkBusy }, loaded.expressions);
    for (const e of VRM_EMOTIONS) {
      if (ownedExpressions.has(e) || !loaded.expressions.available[e]) continue;
      manager.setValue(e, lastApplied[e]);
    }
    if (!ownedExpressions.has('aa')) manager.setValue('aa', mouth.aa);
    if (!ownedExpressions.has('ih')) manager.setValue('ih', mouth.ih);
    if (!ownedExpressions.has('ou')) manager.setValue('ou', mouth.ou);
    if (!ownedExpressions.has('blink')) manager.setValue('blink', frame.blinkWeight);
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
      if (deps.signal.aborted) throw abortError();
      if (config.kind !== 'vrm' || !config.vrm) throw new VrmLoadError('This persona does not use a 3D character.');
      const vrmSettings = config.vrm;
      if (!vrmSettings.model) throw new VrmLoadError('This persona has no 3D model yet. Upload one in its settings.');

      unload();
      const st = ensureStage();

      const key = modelCacheKey(vrmSettings.model.url, vrmSettings.model.sha256);
      const model = await cachedModel(key, async () => {
        const bytes = await deps.resolveAsset(vrmSettings.model!.url);
        if (deps.signal.aborted) throw abortError();
        return modelLoader(bytes, vrmSettings.model!.url);
      });
      if (deps.signal.aborted || !current()) throw abortError();

      const clipsLoaded: Array<ReturnType<typeof describeClip>> = [];
      for (const ref of vrmSettings.clips ?? []) {
        const bytes = await deps.resolveAsset(ref.url);
        if (deps.signal.aborted || !current()) throw abortError();
        const animation = await clipLoader(bytes, ref.url);
        if (deps.signal.aborted || !current()) throw abortError();
        clipsLoaded.push(describeClip(ref, createVRMAnimationClip(animation, model.vrm)));
      }

      loaded = model;
      settings = vrmSettings;
      idleSettings = { ...DEFAULT_IDLE, ...(vrmSettings.idle ?? {}) };
      emotionSettings = { ...DEFAULT_EMOTION, ...(vrmSettings.emotion ?? {}) };
      reactions = Array.isArray(vrmSettings.reactions) ? vrmSettings.reactions : [];
      idle = createIdleState(options.seed ?? (now() | 0), idleSettings);
      expressions = createExpressionState(emotionSettings, model.expressions);
      timers = createReactionTimers();
      mouth = INITIAL_MOUTH;

      st.scene.add(model.vrm.scene);
      hipsRestY = bone('hips')?.position.y ?? 0;
      player = new VrmaPlayer(model.vrm, { random });
      for (const c of clipsLoaded) player.add(c);

      st.scene.background = new THREE.Color(vrmSettings.camera?.background || '#ffffff');
      frameCamera(st, model.vrm, vrmSettings.camera);
      lowerArms(new Set());
      model.vrm.update(0);
    },

    update(dtMs: number, input: DriverInput): void {
      if (disposed || !loaded || !stage || !player) return;
      const dt = Math.min(Math.max(0, dtMs), MAX_FRAME_MS);
      const t = now();

      // 1. Reactions: at most one fires per frame; gestures are consumed by this update.
      let cue: EmotionCue | null = input.cue;
      const matched = matchReactions(reactions, { isThinking: input.isThinking, gestures: input.gestures, faces: input.faces }, t, timers, random);
      timers = matched.timers;
      if (matched.fired) {
        lastReactionId = matched.fired.id;
        const play = matched.fired.play;
        if (play.type === 'clip') player.playOneShot(play.clip_id, play.crossfade_ms);
        else if (!cue) cue = { emotion: play.expression, weight: play.weight, hold_ms: play.hold_ms };
      }

      // 2. Clips advance first; they own what they animate for this frame.
      player.stepIdle(dt, idleSettings.idle_clip_ids ?? [], idleSettings.idle_clip_interval_ms ?? [8000, 20000]);
      player.update(dt / 1000);
      const owned = player.authority;

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
      if (stage) {
        stage.renderer.dispose();
        stage.renderer.forceContextLoss?.();
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
      };
    },
  };

  return driver;
}
