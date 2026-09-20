/**
 * Enough of a VRM to drive without a GPU.
 *
 * three.js itself runs in Node — Object3D, the mixer, quaternions — so a fake
 * model is a real scene graph with the members the driver reads: a humanoid
 * that hands out normalised bone nodes, an expression manager that records
 * weights, a look-at with `autoUpdate`/`target`, and a `meta`. Only the
 * renderer is a stub. The fakes are exported so the 2D adapter's and the
 * surface's tests can use the same ones.
 */
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import type { VRMLookAt } from '@pixiv/three-vrm';
import { VRMAnimation, VRMLookAtQuaternionProxy } from '@pixiv/three-vrm-animation';
import type { StageRenderer } from '../driver/scene';
import type { LoadedModel, ModelLoader, ClipLoader } from '../driver/loader';
import { LOOK_AT_PROXY_NAME, readExpressionModel } from '../driver/loader';
import type { OverrideMode } from '../driver/expressions';

export interface FakeRenderer extends StageRenderer {
  renders: number;
  size: { width: number; height: number; pixelRatio: number };
  disposed: number;
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
        setPixelRatio(ratio) { r.size.pixelRatio = ratio; },
        setSize(width, height) { r.size.width = width; r.size.height = height; },
        render() { r.renders++; },
        dispose() { r.disposed++; },
        forceContextLoss() { /* nothing to lose */ },
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

/** A VRM-shaped object the driver can load, drive and read back. */
export function fakeVrm(options: FakeVrmOptions = {}): VRM & { weights: Record<string, number>; updates: number } {
  const scene = new THREE.Group();
  scene.name = 'fakeVrmScene';
  const bones = new Map<string, THREE.Object3D>();
  let parent: THREE.Object3D = scene;
  const heights: Record<string, number> = { hips: 0.9, spine: 1.0, chest: 1.15, upperChest: 1.25, neck: 1.4, head: 1.5 };
  for (const name of HUMANOID_BONES) {
    const node = new THREE.Object3D();
    node.name = `Normalized_${name}`;
    const y = heights[name] ?? 1.0;
    node.position.set(0, name === 'hips' ? y : 0.1, 0);
    if (name === 'hips') parent = scene;
    parent.add(node);
    bones.set(name, node);
    if (['hips', 'spine', 'chest', 'upperChest', 'neck'].includes(name)) parent = node;
    else parent = bones.get('hips')!;
  }

  const expressionNames = options.expressions ?? ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised', 'aa', 'ih', 'ou', 'ee', 'oh', 'blink'];
  const expressions = new Map<string, FakeExpression>();
  const weights: Record<string, number> = {};
  for (const name of expressionNames) {
    expressions.set(name, {
      expressionName: name,
      weight: 0,
      overrideMouth: options.overrideMouth?.[name] ?? 'none',
      overrideBlink: options.overrideBlink?.[name] ?? 'none',
      overrideLookAt: 'none',
    });
    weights[name] = 0;
  }
  const expressionManager = {
    getExpression: (name: string) => expressions.get(name) ?? null,
    getExpressionTrackName: (name: string) => (expressions.has(name) ? `VRMExpression_${name}.weight` : null),
    setValue: (name: string, w: number) => { if (expressions.has(name)) weights[name] = w; },
    getValue: (name: string) => (expressions.has(name) ? weights[name] : null),
    update: () => undefined,
  };

  const lookAt = options.lookAt === false ? undefined : { autoUpdate: true, target: null as THREE.Object3D | null, yaw: 0, pitch: 0, update: () => undefined };
  const restPose: Record<string, { position?: [number, number, number] }> = { hips: { position: [0, heights.hips, 0] } };

  const fake = {
    scene,
    meta: options.metaVersion === '0'
      ? { metaVersion: '0', title: 'Fake 0.x', author: 'Nobody', licenseName: 'CC0', allowedUserName: 'Everyone', commercialUssageName: 'Allow' }
      : { metaVersion: '1', name: 'Fake', authors: ['Nobody'], licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'everyone', commercialUsage: 'personalNonProfit' },
    humanoid: {
      getNormalizedBoneNode: (name: string) => bones.get(name) ?? null,
      getRawBoneNode: (name: string) => bones.get(name) ?? null,
      normalizedRestPose: restPose,
      autoUpdateHumanBones: true,
    },
    expressionManager,
    lookAt,
    updates: 0,
    weights,
    update(_dt: number) { fake.updates++; },
  };
  return fake as unknown as VRM & { weights: Record<string, number>; updates: number };
}

/** A loader that ignores the bytes and hands back a fake, wearing the proxy the real loader adds. */
export function fakeModelLoader(options: FakeVrmOptions = {}): { loader: ModelLoader; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    loader: async (_bytes, source) => {
      calls.push(source);
      const vrm = fakeVrm(options);
      if (vrm.lookAt) {
        // The real class, so `createVRMAnimationClip` finds it by `instanceof`
        // and writes its look-at track onto it instead of adding a second one.
        const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt as VRMLookAt);
        proxy.name = LOOK_AT_PROXY_NAME;
        vrm.scene.add(proxy);
      }
      const loaded: LoadedModel = { vrm, meta: { metaVersion: '1', name: 'Fake', authors: ['Nobody'], licence: null, licenceUrl: null, avatarPermission: null, commercialUsage: null }, expressions: readExpressionModel(vrm) };
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
