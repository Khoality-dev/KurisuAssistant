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
 * and forth costs a scene swap, not a parse. A parsed model is one mutable
 * scene graph, and three lets an object have one parent, so the cache hands
 * each *instance* to one owner at a time: a driver acquires an instance (a
 * free one, or its own from an earlier load), and a second live driver asking
 * for the same key — the editor's preview beside the window — gets a second
 * parse rather than stealing the first. The cache owns a model's GPU
 * resources and `evictModel`/`clearModelCache` are the only things that
 * dispose them; a driver's `dispose` only releases what it held.
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

export function summariseMeta(vrm: VRM): VrmMetaSummary {
  const meta = vrm.meta as unknown as Record<string, unknown>;
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

/** Who holds an instance: a driver's private token. */
export type ModelOwner = symbol;

interface Waiter {
  owner: ModelOwner;
  load: () => Promise<LoadedModel>;
  signal: AbortSignal;
}

interface Instance {
  key: string;
  owner: ModelOwner | null;
  model: LoadedModel | null;
  /** The parse in flight, shared by every waiter on this instance. */
  pending: Promise<LoadedModel> | null;
  /** Callers still wanting the result; each brought its own fetch and signal. */
  waiters: Set<Waiter>;
}

const instances = new Map<string, Instance[]>();

export function modelCacheKey(url: string, sha256: string): string {
  return `${url}@${sha256}`;
}

function abortError(): Error {
  const e = new Error('The character load was abandoned.');
  e.name = 'AbortError';
  return e;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function disposeModel(model: LoadedModel): void {
  model.vrm.scene.removeFromParent();
  VRMUtils.deepDispose(model.vrm.scene);
}

function forget(inst: Instance): void {
  const list = instances.get(inst.key);
  if (!list) return;
  const rest = list.filter((i) => i !== inst);
  if (rest.length) instances.set(inst.key, rest);
  else instances.delete(inst.key);
}

/**
 * Run the parse for an instance. A waiter's own fetch may honour that
 * waiter's signal, so when the parse dies of an abort while someone else is
 * still waiting, the next waiter's fetch is tried; any other failure is
 * everyone's. A parse that lands after every waiter has gone is dropped —
 * nobody asked for it, and a model nobody references is a GPU leak.
 */
async function parse(inst: Instance): Promise<LoadedModel> {
  for (;;) {
    const next = [...inst.waiters].find((w) => !w.signal.aborted) ?? [...inst.waiters][0];
    if (!next) {
      forget(inst);
      throw abortError();
    }
    let model: LoadedModel;
    try {
      model = await next.load();
    } catch (error) {
      if (isAbort(error) && [...inst.waiters].some((w) => w !== next && !w.signal.aborted)) {
        inst.waiters.delete(next);
        continue;
      }
      forget(inst);
      throw error;
    }
    if (inst.waiters.size === 0 || [...inst.waiters].every((w) => w.signal.aborted)) {
      disposeModel(model);
      forget(inst);
      throw abortError();
    }
    inst.model = model;
    inst.pending = null;
    return model;
  }
}

/**
 * The model for a key, held by `owner` until `releaseModel`. Rejects with an
 * `AbortError` when `signal` fires first; the shared parse carries on for
 * whoever else is waiting.
 */
export function acquireModel(
  key: string,
  owner: ModelOwner,
  load: () => Promise<LoadedModel>,
  signal: AbortSignal,
): Promise<LoadedModel> {
  if (signal.aborted) return Promise.reject(abortError());
  const list = instances.get(key) ?? [];
  let inst = list.find((i) => i.owner === owner) ?? list.find((i) => i.owner === null);
  if (!inst) {
    inst = { key, owner, model: null, pending: null, waiters: new Set() };
    instances.set(key, [...list, inst]);
  }
  inst.owner = owner;
  if (inst.model) return Promise.resolve(inst.model);

  const waiter: Waiter = { owner, load, signal };
  inst.waiters.add(waiter);
  if (!inst.pending) inst.pending = parse(inst);
  const pending = inst.pending;
  const mine = inst;

  // A waiter that gives up lets go of the claim — unless the same owner is
  // still waiting on this instance through a newer load.
  const letGo = () => {
    mine.waiters.delete(waiter);
    if (mine.owner === owner && ![...mine.waiters].some((w) => w.owner === owner)) mine.owner = null;
  };

  return new Promise<LoadedModel>((resolve, reject) => {
    const onAbort = () => {
      letGo();
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (model) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
          letGo();
          reject(abortError());
        } else {
          mine.waiters.delete(waiter);
          resolve(model);
        }
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        letGo();
        reject(signal.aborted ? abortError() : error);
      },
    );
  });
}

/** Let go of the instance `owner` holds for `key`; the parse stays cached for the next load. */
export function releaseModel(key: string, owner: ModelOwner): void {
  for (const inst of instances.get(key) ?? []) {
    if (inst.owner === owner) inst.owner = null;
  }
}

/** Whether any instance of the key is parsed or parsing. */
export function hasCachedModel(key: string): boolean {
  return (instances.get(key) ?? []).length > 0;
}

/** How many parsed instances of a key exist — one per driver that drew it at the same time. */
export function cachedInstanceCount(key: string): number {
  return (instances.get(key) ?? []).filter((i) => i.model).length;
}

/** Drop every instance of a key and free its GPU resources. The callers must not be drawing it. */
export async function evictModel(key: string): Promise<void> {
  const list = instances.get(key) ?? [];
  instances.delete(key);
  for (const inst of list) {
    if (inst.model) {
      disposeModel(inst.model);
      inst.model = null;
    } else if (inst.pending) {
      try {
        const model = await inst.pending;
        disposeModel(model);
      } catch {
        // a load that failed owns nothing
      }
    }
  }
}

export async function clearModelCache(): Promise<void> {
  await Promise.all([...instances.keys()].map(evictModel));
}
