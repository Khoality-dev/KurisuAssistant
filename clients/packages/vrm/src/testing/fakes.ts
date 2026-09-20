/**
 * Enough of a VRM to drive without a GPU.
 *
 * three.js itself runs in Node — Object3D, the mixer, quaternions — so a fake
 * model is a real scene graph with the members the driver reads: a humanoid
 * that hands out normalised bone nodes laid out like a T-pose (arms along the
 * x axis, the way a real rig's are, and mirrored for a 0.x model that faces
 * -Z), an expression manager that records weights AND applies three-vrm's
 * override arithmetic so a test sees what the mesh would, a look-at with
 * `autoUpdate`/`target`, and a `meta`. Only the renderer is a stub. The fakes
 * are exported so the 2D adapter's and the surface's tests can use the same
 * ones.
 */
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import type { VRMLookAt } from '@pixiv/three-vrm';
import { VRMAnimation, VRMLookAtQuaternionProxy } from '@pixiv/three-vrm-animation';
import type { StageRenderer } from '../driver/scene';
import type { LoadedModel, ModelLoader, ClipLoader } from '../driver/loader';
import { LOOK_AT_PROXY_NAME, readExpressionModel, summariseMeta } from '../driver/loader';
import type { OverrideMode } from '../driver/expressions';

export interface FakeRenderer extends StageRenderer {
  renders: number;
  size: { width: number; height: number; pixelRatio: number };
  disposed: number;
  contextLosses: number;
}

export function fakeRendererFactory(): { factory: (canvas: HTMLCanvasElement) => FakeRenderer; renderers: FakeRenderer[] } {
  const renderers: FakeRenderer[] = [];
  return {
    renderers,
    factory: () => {
      const r: FakeRenderer = {
        renders: 0,
        size: { width: 0, height: 0, pixelRatio: 1 },
        disposed: 0,
        contextLosses: 0,
        setPixelRatio(ratio) { r.size.pixelRatio = ratio; },
        setSize(width, height) { r.size.width = width; r.size.height = height; },
        render() { r.renders++; },
        dispose() { r.disposed++; },
        forceContextLoss() { r.contextLosses++; },
      };
      renderers.push(r);
      return r;
    },
  };
}

const HUMANOID_BONES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
] as const;

const MOUTH_PRESETS = ['aa', 'ih', 'ou', 'ee', 'oh'];
const BLINK_PRESETS = ['blink', 'blinkLeft', 'blinkRight'];

export interface FakeVrmOptions {
  metaVersion?: '0' | '1';
  /** Which preset expressions the model exposes; default: all six plus the mouth and blink presets. */
  expressions?: string[];
  overrideMouth?: Record<string, OverrideMode>;
  overrideBlink?: Record<string, OverrideMode>;
  /** Whether the model has a look-at at all. */
  lookAt?: boolean;
}

interface FakeExpression {
  expressionName: string;
  weight: number;
  overrideMouth: OverrideMode;
  overrideBlink: OverrideMode;
  overrideLookAt: OverrideMode;
}

export interface FakeVrm extends VRM {
  /** What the driver set, per expression. */
  weights: Record<string, number>;
  /** What the mesh would show after three-vrm's override multipliers, computed on `update`. */
  effective: Record<string, number>;
  updates: number;
  resets: number;
}

function overrideAmount(mode: OverrideMode, weight: number): number {
  if (mode === 'block') return weight > 0 ? 1 : 0;
  if (mode === 'blend') return weight;
  return 0;
}

/** A VRM-shaped object the driver can load, drive and read back. */
export function fakeVrm(options: FakeVrmOptions = {}): FakeVrm {
  const v0 = options.metaVersion === '0';
  const scene = new THREE.Group();
  scene.name = 'fakeVrmScene';
  const bones = new Map<string, THREE.Object3D>();
  const heights: Record<string, number> = { hips: 0.9, spine: 1.0, chest: 1.15, upperChest: 1.25, neck: 1.4, head: 1.5 };
  // A T-pose: the left arm runs along +x on a 1.0 model (facing +Z) and along
  // -x on a 0.x model (facing -Z); either way the forearm continues outward.
  const left = v0 ? -1 : 1;
  const layout: Record<string, [string, [number, number, number]]> = {
    hips: ['scene', [0, heights.hips, 0]],
    spine: ['hips', [0, 0.1, 0]],
    chest: ['spine', [0, 0.15, 0]],
    upperChest: ['chest', [0, 0.1, 0]],
    neck: ['upperChest', [0, 0.15, 0]],
    head: ['neck', [0, 0.1, 0]],
    leftShoulder: ['upperChest', [left * 0.05, 0.1, 0]],
    leftUpperArm: ['leftShoulder', [left * 0.1, 0, 0]],
    leftLowerArm: ['leftUpperArm', [left * 0.25, 0, 0]],
    leftHand: ['leftLowerArm', [left * 0.25, 0, 0]],
    rightShoulder: ['upperChest', [-left * 0.05, 0.1, 0]],
    rightUpperArm: ['rightShoulder', [-left * 0.1, 0, 0]],
    rightLowerArm: ['rightUpperArm', [-left * 0.25, 0, 0]],
    rightHand: ['rightLowerArm', [-left * 0.25, 0, 0]],
    leftUpperLeg: ['hips', [left * 0.1, -0.05, 0]],
    leftLowerLeg: ['leftUpperLeg', [0, -0.4, 0]],
    leftFoot: ['leftLowerLeg', [0, -0.4, 0]],
    rightUpperLeg: ['hips', [-left * 0.1, -0.05, 0]],
    rightLowerLeg: ['rightUpperLeg', [0, -0.4, 0]],
    rightFoot: ['rightLowerLeg', [0, -0.4, 0]],
  };
  for (const name of HUMANOID_BONES) {
    const node = new THREE.Object3D();
    node.name = `Normalized_${name}`;
    const [parentName, pos] = layout[name];
    node.position.set(pos[0], pos[1], pos[2]);
    (parentName === 'scene' ? scene : bones.get(parentName)!).add(node);
    bones.set(name, node);
  }
  const restPositions = new Map([...bones].map(([name, node]) => [name, node.position.clone()]));

  const expressionNames = options.expressions ?? ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised', ...MOUTH_PRESETS, 'blink'];
  const expressions = new Map<string, FakeExpression>();
  const weights: Record<string, number> = {};
  const effective: Record<string, number> = {};
  for (const name of expressionNames) {
    expressions.set(name, {
      expressionName: name,
      weight: 0,
      overrideMouth: options.overrideMouth?.[name] ?? 'none',
      overrideBlink: options.overrideBlink?.[name] ?? 'none',
      overrideLookAt: 'none',
    });
    weights[name] = 0;
    effective[name] = 0;
  }
  const expressionManager = {
    getExpression: (name: string) => expressions.get(name) ?? null,
    getExpressionTrackName: (name: string) => (expressions.has(name) ? `VRMExpression_${name}.weight` : null),
    setValue: (name: string, w: number) => { if (expressions.has(name)) weights[name] = w; },
    getValue: (name: string) => (expressions.has(name) ? weights[name] : null),
    resetValues: () => { for (const name of expressions.keys()) { weights[name] = 0; effective[name] = 0; } },
    // three-vrm's `_calculateWeightMultipliers` + `applyWeight`, so a test
    // sees the mouth a `block` expression mutes.
    update: () => {
      let mouth = 1;
      let blink = 1;
      for (const [name, e] of expressions) {
        mouth -= overrideAmount(e.overrideMouth, weights[name]);
        blink -= overrideAmount(e.overrideBlink, weights[name]);
      }
      mouth = Math.max(0, mouth);
      blink = Math.max(0, blink);
      for (const name of expressions.keys()) {
        let m = 1;
        if (MOUTH_PRESETS.includes(name)) m *= mouth;
        if (BLINK_PRESETS.includes(name)) m *= blink;
        effective[name] = weights[name] * m;
      }
    },
  };

  const lookAt = options.lookAt === false
    ? undefined
    : {
        autoUpdate: true,
        target: null as THREE.Object3D | null,
        yaw: 0,
        pitch: 0,
        resets: 0,
        update: () => undefined,
        reset() { this.yaw = 0; this.pitch = 0; this.resets++; },
      };
  const restPose: Record<string, { position?: [number, number, number] }> = { hips: { position: [0, heights.hips, 0] } };

  const fake = {
    scene,
    meta: v0
      ? { metaVersion: '0', title: 'Fake 0.x', author: 'Nobody', licenseName: 'CC0', allowedUserName: 'Everyone', commercialUssageName: 'Allow' }
      : { metaVersion: '1', name: 'Fake', authors: ['Nobody'], licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'everyone', commercialUsage: 'personalNonProfit' },
    humanoid: {
      getNormalizedBoneNode: (name: string) => bones.get(name) ?? null,
      getRawBoneNode: (name: string) => bones.get(name) ?? null,
      normalizedRestPose: restPose,
      autoUpdateHumanBones: true,
      resetNormalizedPose: () => {
        for (const [name, node] of bones) {
          node.rotation.set(0, 0, 0);
          node.position.copy(restPositions.get(name)!);
        }
        fake.resets++;
      },
    },
    expressionManager,
    lookAt,
    updates: 0,
    resets: 0,
    weights,
    effective,
    update(_dt: number) { fake.updates++; expressionManager.update(); },
  };
  return fake as unknown as FakeVrm;
}

/** A loader that ignores the bytes and hands back a fake, wearing the proxy the real loader adds. */
export function fakeModelLoader(options: FakeVrmOptions = {}): { loader: ModelLoader; calls: string[]; vrms: FakeVrm[] } {
  const calls: string[] = [];
  const vrms: FakeVrm[] = [];
  return {
    calls,
    vrms,
    loader: async (_bytes, source) => {
      calls.push(source);
      const vrm = fakeVrm(options);
      vrms.push(vrm);
      if (vrm.lookAt) {
        // The real class, so `createVRMAnimationClip` finds it by `instanceof`
        // and writes its look-at track onto it instead of adding a second one.
        const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt as VRMLookAt);
        proxy.name = LOOK_AT_PROXY_NAME;
        vrm.scene.add(proxy);
      }
      const loaded: LoadedModel = { vrm, meta: summariseMeta(vrm), expressions: readExpressionModel(vrm) };
      return loaded;
    },
  };
}

export interface FakeAnimationOptions {
  /** Bones the clip rotates, by humanoid name. */
  bones?: string[];
  /** Presets the clip drives. */
  expressions?: string[];
  lookAt?: boolean;
  durationS?: number;
}

/** A VRMAnimation with the given tracks, so `createVRMAnimationClip` produces a real clip. */
export function fakeVrmAnimation(options: FakeAnimationOptions = {}): VRMAnimation {
  const anim = new VRMAnimation();
  const duration = options.durationS ?? 1;
  anim.duration = duration;
  anim.restHipsPosition = new THREE.Vector3(0, 0.9, 0);
  for (const name of options.bones ?? []) {
    anim.humanoidTracks.rotation.set(name as never, new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, [0, duration], [0, 0, 0, 1, 0, 0.3826834, 0, 0.9238795]));
  }
  for (const name of options.expressions ?? []) {
    anim.expressionTracks.preset.set(name as never, new THREE.NumberKeyframeTrack(`${name}.weight`, [0, duration], [0, 1]));
  }
  if (options.lookAt) {
    anim.lookAtTrack = new THREE.QuaternionKeyframeTrack('lookAt.quaternion', [0, duration], [0, 0, 0, 1, 0, 0.1, 0, 0.995]);
  }
  return anim;
}

export function fakeClipLoader(byUrl: Record<string, FakeAnimationOptions> = {}): { loader: ClipLoader; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    loader: async (_bytes, source) => {
      calls.push(source);
      return fakeVrmAnimation(byUrl[source] ?? {});
    },
  };
}
