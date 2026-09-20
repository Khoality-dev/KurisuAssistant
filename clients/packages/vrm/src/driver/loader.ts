/**
 * Bytes in, a ready model out.
 *
 * Models arrive as an ArrayBuffer — fetched by the host with whatever auth it
 * holds — and go through `GLTFLoader.parse`, never `.load` by URL, so no
 * loader ever sees a token or a route. Before three touches the bytes the GLB
 * header is read here: a file that is not a VRM, or one that needs a mesh or
 * texture decoder this package deliberately does not ship (VRoid exports are
 * uncompressed), is refused with a sentence rather than a stack trace.
 *
 * Parsed models are cached by `${url}@${sha256}` so switching personas back
 * and forth costs a scene swap, not a parse; the cache is the owner of a
 * model's GPU resources and `evictModel`/`clearModelCache` are the only
 * things that dispose them. A driver's `dispose` only lets go.
 */
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimation, VRMAnimationLoaderPlugin, VRMLookAtQuaternionProxy } from '@pixiv/three-vrm-animation';
import type { VrmEmotion } from '@kurisu/models';
import { VRM_EMOTIONS } from '@kurisu/models';
import { everyEmotion, type ExpressionModel, type OverrideMode } from './expressions';

/** A load failure the user can read. */
export class VrmLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VrmLoadError';
  }
}

/** The name every driver gives the one look-at proxy it adds to a model. */
export const LOOK_AT_PROXY_NAME = 'VRMLookAtQuaternionProxy';

/** What the model-info card shows: plain strings, every one truncated. */
export interface VrmMetaSummary {
  metaVersion: '0' | '1';
  name: string | null;
  authors: string[];
  licence: string | null;
  licenceUrl: string | null;
  /** VRM 1.0 `avatarPermission` / VRM 0.x `allowedUserName`, as exported. */
  avatarPermission: string | null;
  /** VRM 1.0 `commercialUsage` / VRM 0.x `commercialUssageName`, as exported. */
  commercialUsage: string | null;
}

export interface LoadedModel {
  vrm: VRM;
  meta: VrmMetaSummary;
  expressions: ExpressionModel;
}

export type ModelLoader = (bytes: ArrayBuffer, source: string) => Promise<LoadedModel>;
export type ClipLoader = (bytes: ArrayBuffer, source: string) => Promise<VRMAnimation>;

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const DECODERS: Record<string, string> = {
  KHR_draco_mesh_compression: 'Draco mesh compression',
  KHR_texture_basisu: 'KTX2 / Basis textures',
  EXT_meshopt_compression: 'meshopt compression',
  KHR_mesh_quantization: '',
};

interface GlbHeader {
  json: Record<string, unknown>;
}

/** Read the GLB header and its JSON chunk without letting three near the bytes. */
export function readGlbHeader(bytes: ArrayBuffer): GlbHeader {
  if (bytes.byteLength < 20) throw new VrmLoadError('This file is too small to be a VRM.');
  const view = new DataView(bytes);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new VrmLoadError('This file is not a VRM (not a glTF binary).');
  if (view.getUint32(4, true) !== 2) throw new VrmLoadError('This file is not a VRM (unsupported glTF version).');
  const chunkLength = view.getUint32(12, true);
  const chunkType = view.getUint32(16, true);
  if (chunkType !== JSON_CHUNK || chunkLength > bytes.byteLength - 20) {
    throw new VrmLoadError('This file is not a VRM (malformed header).');
  }
  const text = new TextDecoder('utf-8').decode(new Uint8Array(bytes, 20, chunkLength));
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new VrmLoadError('This file is not a VRM (unreadable header).');
  }
  if (!json || typeof json !== 'object') throw new VrmLoadError('This file is not a VRM (unreadable header).');
  return { json: json as Record<string, unknown> };
}

function extensionsOf(json: Record<string, unknown>): { used: string[]; required: string[] } {
  const used = Array.isArray(json.extensionsUsed) ? (json.extensionsUsed as unknown[]).filter((e): e is string => typeof e === 'string') : [];
  const required = Array.isArray(json.extensionsRequired) ? (json.extensionsRequired as unknown[]).filter((e): e is string => typeof e === 'string') : [];
  return { used, required };
}

/** Refuse, with a sentence, what this package cannot or will not open. */
export function checkVrmHeader(bytes: ArrayBuffer, expect: 'model' | 'clip'): void {
  const { json } = readGlbHeader(bytes);
  const { used, required } = extensionsOf(json);
  const all = new Set([...used, ...required]);
  for (const [ext, label] of Object.entries(DECODERS)) {
    if (label && all.has(ext)) {
      throw new VrmLoadError(`This model needs ${label}, which this app does not ship. Export it without compression.`);
    }
  }
  if (expect === 'model' && !all.has('VRM') && !all.has('VRMC_vrm')) {
    throw new VrmLoadError('This file is a glTF binary but not a VRM model.');
  }
  if (expect === 'clip' && !all.has('VRMC_vrm_animation')) {
    throw new VrmLoadError('This file is not a VRM animation (.vrma).');
  }
}

function makeLoader(): GLTFLoader {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  return loader;
}

const MAX_META = 256;
function str(value: unknown): string | null {
  return typeof value === 'string' && value.length ? value.slice(0, MAX_META) : null;
}

function summariseMeta(vrm: VRM): VrmMetaSummary {
  const meta = vrm.meta as Record<string, unknown>;
  if (meta.metaVersion === '1') {
    const authors = Array.isArray(meta.authors) ? (meta.authors as unknown[]).map(str).filter((a): a is string => !!a) : [];
    return {
      metaVersion: '1',
      name: str(meta.name),
      authors,
      // VRM 1.0 has no licence name, only the URL of the VRM public licence
      // (and, optionally, another document's).
      licence: null,
      licenceUrl: str(meta.licenseUrl) ?? str(meta.otherLicenseUrl),
      avatarPermission: str(meta.avatarPermission),
      commercialUsage: str(meta.commercialUsage),
    };
  }
  return {
    metaVersion: '0',
    name: str(meta.title),
    authors: str(meta.author) ? [str(meta.author) as string] : [],
    licence: str(meta.licenseName),
    licenceUrl: str(meta.otherLicenseUrl),
    avatarPermission: str(meta.allowedUserName),
    commercialUsage: str(meta.commercialUssageName),
  };
}

/** Which of the six presets the model exposes, and how each overrides mouth and blink. */
export function readExpressionModel(vrm: Pick<VRM, 'expressionManager'>): ExpressionModel {
  const available = everyEmotion(false);
  const overrideMouth = everyEmotion<OverrideMode>('none');
  const overrideBlink = everyEmotion<OverrideMode>('none');
  const manager = vrm.expressionManager;
  for (const e of VRM_EMOTIONS as readonly VrmEmotion[]) {
    const expression = manager?.getExpression(e) ?? null;
    if (!expression) continue;
    available[e] = true;
    overrideMouth[e] = (expression.overrideMouth as OverrideMode) ?? 'none';
    overrideBlink[e] = (expression.overrideBlink as OverrideMode) ?? 'none';
  }
  return { available, overrideMouth, overrideBlink };
}

/** The real thing: parse, tidy, orient, and hang the look-at proxy. */
export const loadVrmModel: ModelLoader = async (bytes, source) => {
  checkVrmHeader(bytes, 'model');
  let gltf;
  try {
    gltf = await makeLoader().parseAsync(bytes, '');
  } catch (error) {
    throw new VrmLoadError(`Could not read ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) throw new VrmLoadError('This file is a glTF binary but not a VRM model.');

  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.rotateVRM0(vrm);
  vrm.scene.traverse((obj) => { obj.frustumCulled = false; });

  if (vrm.lookAt) {
    const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
    proxy.name = LOOK_AT_PROXY_NAME;
    vrm.scene.add(proxy);
  }

  return { vrm, meta: summariseMeta(vrm), expressions: readExpressionModel(vrm) };
};

export const loadVrmClip: ClipLoader = async (bytes, source) => {
  checkVrmHeader(bytes, 'clip');
  let gltf;
  try {
    gltf = await makeLoader().parseAsync(bytes, '');
  } catch (error) {
    throw new VrmLoadError(`Could not read ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const animations = gltf.userData.vrmAnimations as VRMAnimation[] | undefined;
  if (!animations?.length) throw new VrmLoadError('This file is not a VRM animation (.vrma).');
  return animations[0];
};

// ─── The parsed-model cache ───

const cache = new Map<string, Promise<LoadedModel>>();

export function modelCacheKey(url: string, sha256: string): string {
  return `${url}@${sha256}`;
}

/** The cached model for a key, loading it once if absent. A failed load is not cached. */
export function cachedModel(key: string, load: () => Promise<LoadedModel>): Promise<LoadedModel> {
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = load().catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  return pending;
}

export function hasCachedModel(key: string): boolean {
  return cache.has(key);
}

/** Drop one model and free its GPU resources. The caller must not be drawing it. */
export async function evictModel(key: string): Promise<void> {
  const pending = cache.get(key);
  cache.delete(key);
  if (!pending) return;
  try {
    const loaded = await pending;
    loaded.vrm.scene.removeFromParent();
    VRMUtils.deepDispose(loaded.vrm.scene);
  } catch {
    // a load that failed owns nothing
  }
}

export async function clearModelCache(): Promise<void> {
  await Promise.all([...cache.keys()].map(evictModel));
}
