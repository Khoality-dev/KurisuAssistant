import { describe, expect, it, beforeEach } from 'vitest';
import {
  acquireModel,
  cachedInstanceCount,
  checkVrmHeader,
  clearModelCache,
  evictModel,
  hasCachedModel,
  modelCacheKey,
  readGlbHeader,
  releaseModel,
  VrmLoadError,
  type LoadedModel,
} from './loader';
import { fakeModelLoader } from '../testing/fakes';

/** A GLB in memory: the 12-byte header, then one JSON chunk. */
function glb(json: unknown, options: { magic?: number; version?: number; chunkType?: number; declaredLength?: number } = {}): ArrayBuffer {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const padded = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20);
  padded.set(text);
  const total = 12 + 8 + padded.length;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  view.setUint32(0, options.magic ?? 0x46546c67, true);
  view.setUint32(4, options.version ?? 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, options.declaredLength ?? padded.length, true);
  view.setUint32(16, options.chunkType ?? 0x4e4f534a, true);
  new Uint8Array(buf, 20).set(padded);
  return buf;
}

const VRM1 = { asset: { version: '2.0' }, extensionsUsed: ['VRMC_vrm'] };

describe('the GLB header check', () => {
  it('reads a well-formed header', () => {
    expect(readGlbHeader(glb(VRM1)).json).toEqual(VRM1);
  });

  it('refuses what is not a GLB, with a sentence', () => {
    expect(() => readGlbHeader(new ArrayBuffer(4))).toThrow(VrmLoadError);
    expect(() => readGlbHeader(new ArrayBuffer(4))).toThrow(/too small/);
    expect(() => readGlbHeader(glb(VRM1, { magic: 0x12345678 }))).toThrow(/not a glTF binary/);
    expect(() => readGlbHeader(glb(VRM1, { version: 1 }))).toThrow(/unsupported glTF version/);
    expect(() => readGlbHeader(glb(VRM1, { chunkType: 0x004e4942 }))).toThrow(/malformed header/);
    expect(() => readGlbHeader(glb(VRM1, { declaredLength: 1 << 30 }))).toThrow(/malformed header/);
  });

  it('refuses a JSON chunk that is not an object', () => {
    expect(() => readGlbHeader(glb('just a string'))).toThrow(/unreadable header/);
    expect(() => readGlbHeader(glb(null))).toThrow(/unreadable header/);
    const broken = glb(VRM1);
    new Uint8Array(broken, 20).set(new TextEncoder().encode('{"a":'));
    expect(() => readGlbHeader(broken)).toThrow(/unreadable header/);
  });

  it('accepts a VRM 0.x and a VRM 1.0 model, and refuses a plain glTF', () => {
    expect(() => checkVrmHeader(glb({ extensionsUsed: ['VRM'] }), 'model')).not.toThrow();
    expect(() => checkVrmHeader(glb(VRM1), 'model')).not.toThrow();
    expect(() => checkVrmHeader(glb({ extensionsUsed: ['KHR_materials_unlit'] }), 'model')).toThrow(/not a VRM model/);
  });

  it('refuses a model that needs a decoder this package does not ship, naming it', () => {
    expect(() => checkVrmHeader(glb({ extensionsUsed: ['VRMC_vrm', 'KHR_draco_mesh_compression'] }), 'model')).toThrow(/Draco mesh compression/);
    expect(() => checkVrmHeader(glb({ extensionsUsed: ['VRMC_vrm'], extensionsRequired: ['KHR_texture_basisu'] }), 'model')).toThrow(/KTX2/);
    expect(() => checkVrmHeader(glb({ extensionsUsed: ['VRMC_vrm', 'EXT_meshopt_compression'] }), 'model')).toThrow(/meshopt/);
    // Quantisation needs no decoder and is allowed.
    expect(() => checkVrmHeader(glb({ extensionsUsed: ['VRMC_vrm', 'KHR_mesh_quantization'] }), 'model')).not.toThrow();
  });

  it('tells a clip from a model', () => {
    expect(() => checkVrmHeader(glb({ extensionsUsed: ['VRMC_vrm_animation'] }), 'clip')).not.toThrow();
    expect(() => checkVrmHeader(glb(VRM1), 'clip')).toThrow(/not a VRM animation/);
  });
});

describe('the parsed-model cache', () => {
  const key = modelCacheKey('/character-assets/1/vrm/model', 'a'.repeat(64));
  const live = () => new AbortController().signal;

  beforeEach(async () => {
    await clearModelCache();
  });

  it('parses once for one owner loading the same key twice', async () => {
    const owner = Symbol('a');
    const models = fakeModelLoader();
    const load = () => models.loader(new ArrayBuffer(0), 'm');
    const first = await acquireModel(key, owner, load, live());
    const second = await acquireModel(key, owner, load, live());
    expect(second).toBe(first);
    expect(models.calls).toHaveLength(1);
    expect(cachedInstanceCount(key)).toBe(1);
  });

  it('gives a second live owner its own instance instead of the first owner\'s scene', async () => {
    const models = fakeModelLoader();
    const load = () => models.loader(new ArrayBuffer(0), 'm');
    const a = await acquireModel(key, Symbol('a'), load, live());
    const b = await acquireModel(key, Symbol('b'), load, live());
    expect(b).not.toBe(a);
    expect(b.vrm.scene).not.toBe(a.vrm.scene);
    expect(models.calls).toHaveLength(2);
    expect(cachedInstanceCount(key)).toBe(2);
  });

  it('hands a released instance to the next owner without a parse', async () => {
    const models = fakeModelLoader();
    const load = () => models.loader(new ArrayBuffer(0), 'm');
    const a = Symbol('a');
    const first = await acquireModel(key, a, load, live());
    releaseModel(key, a);
    const second = await acquireModel(key, Symbol('b'), load, live());
    expect(second).toBe(first);
    expect(models.calls).toHaveLength(1);
  });

  it('lets a waiter abort without rejecting the others on the same parse', async () => {
    const models = fakeModelLoader();
    let release!: (m: LoadedModel) => void;
    const gate = new Promise<LoadedModel>((resolve) => { release = resolve; });
    const owner = Symbol('a');
    const slow = () => gate;
    const first = new AbortController();
    const p1 = acquireModel(key, owner, slow, first.signal);
    const p2 = acquireModel(key, owner, slow, live());
    first.abort();
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
    release(await models.loader(new ArrayBuffer(0), 'm'));
    await expect(p2).resolves.toBeTruthy();
    expect(cachedInstanceCount(key)).toBe(1);
  });

  it('drops a parse every waiter abandoned instead of caching it', async () => {
    let release!: (m: LoadedModel) => void;
    const gate = new Promise<LoadedModel>((resolve) => { release = resolve; });
    const controller = new AbortController();
    const p = acquireModel(key, Symbol('a'), () => gate, controller.signal);
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    const models = fakeModelLoader();
    release(await models.loader(new ArrayBuffer(0), 'm'));
    await new Promise((r) => setTimeout(r, 0));
    expect(hasCachedModel(key)).toBe(false);
  });

  it('tries the next waiter\'s fetch when the first one\'s died of its own abort', async () => {
    const models = fakeModelLoader();
    const first = new AbortController();
    const abortingLoad = () => new Promise<LoadedModel>((_, reject) => {
      const e = new Error('fetch aborted');
      e.name = 'AbortError';
      first.signal.addEventListener('abort', () => reject(e));
    });
    const p1 = acquireModel(key, Symbol('a'), abortingLoad, first.signal);
    const p2 = acquireModel(key, Symbol('a'), () => models.loader(new ArrayBuffer(0), 'm'), live());
    first.abort();
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
    await expect(p2).resolves.toBeTruthy();
    expect(models.calls).toEqual(['m']);
  });

  it('does not cache a failed parse, and rejects every waiter with the failure', async () => {
    const boom = () => Promise.reject(new VrmLoadError('nope'));
    const p1 = acquireModel(key, Symbol('a'), boom, live());
    const p2 = acquireModel(key, Symbol('a'), boom, live());
    await expect(p1).rejects.toThrow('nope');
    await expect(p2).rejects.toThrow('nope');
    expect(hasCachedModel(key)).toBe(false);
  });

  it('evicts every instance of a key', async () => {
    const models = fakeModelLoader();
    const load = () => models.loader(new ArrayBuffer(0), 'm');
    await acquireModel(key, Symbol('a'), load, live());
    await acquireModel(key, Symbol('b'), load, live());
    expect(hasCachedModel(key)).toBe(true);
    await evictModel(key);
    expect(hasCachedModel(key)).toBe(false);
    expect(cachedInstanceCount(key)).toBe(0);
    await acquireModel(key, Symbol('c'), load, live());
    expect(models.calls).toHaveLength(3);
  });

  it('rejects at once for a signal that is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const models = fakeModelLoader();
    await expect(acquireModel(key, Symbol('a'), () => models.loader(new ArrayBuffer(0), 'm'), controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(models.calls).toHaveLength(0);
    expect(hasCachedModel(key)).toBe(false);
  });
});
