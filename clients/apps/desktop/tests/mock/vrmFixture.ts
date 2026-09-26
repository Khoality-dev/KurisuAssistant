/**
 * The smallest files the character store accepts and the renderer loads, built
 * in code (#236, #306).
 *
 * Not read from disk: the standalone mock is esbuild-bundled into
 * `dist-mock/cli.js`, where a file path relative to this module would resolve
 * under `dist-mock/` and find nothing. The model is the fifteen humanoid bones
 * three-vrm requires and one flat red quad in front of the upper body, so a
 * renderer draws something that is not the background; the clip turns the hips
 * over one second. The first fixture was a header and a `hips` bone — enough
 * for the backend's validation, not enough to load — so no spec could tell
 * whether a model that reached the app was ever shown (#306).
 */
import { createHash } from 'crypto';

const GLTF_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

function padTo4(bytes: Buffer, fill: number): Buffer {
  const pad = (4 - (bytes.length % 4)) % 4;
  return pad ? Buffer.concat([bytes, Buffer.alloc(pad, fill)]) : bytes;
}

/** A glTF 2.0 binary: `document` as its JSON chunk and, when given, `bin` as its buffer. */
export function buildGlb(document: unknown, bin?: Buffer): Buffer {
  const json = padTo4(Buffer.from(JSON.stringify(document), 'utf8'), 0x20);
  const chunks = [json, ...(bin ? [padTo4(bin, 0)] : [])];
  const types = [CHUNK_JSON, CHUNK_BIN];
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLTF_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + chunks.reduce((n, c) => n + 8 + c.length, 0), 8);
  const parts: Buffer[] = [header];
  chunks.forEach((chunk, i) => {
    const chunkHeader = Buffer.alloc(8);
    chunkHeader.writeUInt32LE(chunk.length, 0);
    chunkHeader.writeUInt32LE(types[i], 4);
    parts.push(chunkHeader, chunk);
  });
  return Buffer.concat(parts);
}

function float32(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Bone, parent, and offset from the parent in metres; VRM 1.0 faces +Z, her left is +X. */
const BONES: Array<[string, string | null, [number, number, number]]> = [
  ['hips', null, [0, 1.0, 0]],
  ['spine', 'hips', [0, 0.15, 0]],
  ['head', 'spine', [0, 0.45, 0]],
  ['leftUpperArm', 'spine', [0.2, 0.3, 0]],
  ['leftLowerArm', 'leftUpperArm', [0.25, 0, 0]],
  ['leftHand', 'leftLowerArm', [0.25, 0, 0]],
  ['rightUpperArm', 'spine', [-0.2, 0.3, 0]],
  ['rightLowerArm', 'rightUpperArm', [-0.25, 0, 0]],
  ['rightHand', 'rightLowerArm', [-0.25, 0, 0]],
  ['leftUpperLeg', 'hips', [0.1, -0.05, 0]],
  ['leftLowerLeg', 'leftUpperLeg', [0, -0.45, 0]],
  ['leftFoot', 'leftLowerLeg', [0, -0.45, 0]],
  ['rightUpperLeg', 'hips', [-0.1, -0.05, 0]],
  ['rightLowerLeg', 'rightUpperLeg', [0, -0.45, 0]],
  ['rightFoot', 'rightLowerLeg', [0, -0.45, 0]],
];

function buildModel(): Buffer {
  // A quad from the hips to above the head, facing the camera.
  const positions = float32([-0.3, 0.9, 0.05, 0.3, 0.9, 0.05, 0.3, 1.75, 0.05, -0.3, 1.75, 0.05]);
  const indices = Buffer.from(new Uint16Array([0, 1, 2, 0, 2, 3]).buffer);
  const bin = Buffer.concat([positions, indices]);
  const nodes: Array<Record<string, unknown>> = BONES.map(([name, , translation]) => ({ name, translation }));
  BONES.forEach(([, parent], i) => {
    if (parent === null) return;
    const p = nodes[BONES.findIndex(([n]) => n === parent)];
    p.children = [...((p.children as number[] | undefined) ?? []), i];
  });
  const body = nodes.push({ name: 'body', mesh: 0 }) - 1;
  const humanBones = Object.fromEntries(BONES.map(([name], i) => [name, { node: i }]));
  return buildGlb({
    asset: { version: '2.0', generator: 'kurisu mock' },
    extensionsUsed: ['VRMC_vrm'],
    extensions: {
      VRMC_vrm: {
        specVersion: '1.0',
        meta: { name: 'Mock Kurisu', authors: ['mock'], licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'onlyAuthor', commercialUsage: 'personalNonProfit' },
        humanoid: { humanBones },
        expressions: { preset: { happy: {}, angry: {}, sad: {}, relaxed: {}, surprised: {}, neutral: {} } },
      },
    },
    scene: 0,
    scenes: [{ nodes: [0, body] }],
    nodes,
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.85, 0.1, 0.1, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-0.3, 0.9, 0.05], max: [0.3, 1.75, 0.05] },
      { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.length, target: 34962 },
      { buffer: 0, byteOffset: positions.length, byteLength: indices.length, target: 34963 },
    ],
    buffers: [{ byteLength: bin.length }],
  }, bin);
}

/** A VRM 1.0 model: a humanoid with all six preset expressions, and a body the camera sees. */
export const VRM_MODEL_BYTES = buildModel();

export const VRM_MODEL_SHA256 = sha256Hex(VRM_MODEL_BYTES);

function buildClip(): Buffer {
  const times = float32([0, 1]);
  const half = Math.SQRT1_2;
  const rotations = float32([0, 0, 0, 1, 0, half, 0, half]); // a quarter turn about Y
  const bin = Buffer.concat([times, rotations]);
  return buildGlb({
    asset: { version: '2.0', generator: 'kurisu mock' },
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: { VRMC_vrm_animation: { specVersion: '1.0', humanoid: { humanBones: { hips: { node: 0 } } } } },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'hips', translation: [0, 1.0, 0] }],
    animations: [{
      channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }],
      samplers: [{ input: 0, output: 1, interpolation: 'LINEAR' }],
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 1, componentType: 5126, count: 2, type: 'VEC4' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: times.length },
      { buffer: 0, byteOffset: times.length, byteLength: rotations.length },
    ],
    buffers: [{ byteLength: bin.length }],
  }, bin);
}

/** A VRMA clip: the hips turn a quarter over one second. */
export const VRMA_CLIP_BYTES = buildClip();

export const VRMA_CLIP_SHA256 = sha256Hex(VRMA_CLIP_BYTES);

const EMOTIONS = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'] as const;
const VRM0_PRESETS: Record<string, (typeof EMOTIONS)[number]> = {
  neutral: 'neutral', joy: 'happy', angry: 'angry', sorrow: 'sad', fun: 'relaxed',
};

/** What the backend's `assets.inspect_*` would say about these bytes, or the refusal code. */
export type Inspection =
  | { ok: true; kind: 'model'; spec_version: '0.x' | '1.0'; expressions: string[]; meta: Record<string, unknown> }
  | { ok: true; kind: 'clip' }
  | { ok: false; code: 'not_glb' | 'not_vrm' | 'no_humanoid' | 'not_vrma' | 'bad_json' };

function readJson(bytes: Buffer): Record<string, any> | 'not_glb' | 'bad_json' {
  if (bytes.length < 12 || bytes.readUInt32LE(0) !== GLTF_MAGIC || bytes.readUInt32LE(4) !== 2) return 'not_glb';
  if (bytes.length < 20 || bytes.readUInt32LE(16) !== CHUNK_JSON) return 'bad_json';
  const length = bytes.readUInt32LE(12);
  if (length > bytes.length - 20) return 'bad_json';
  try {
    const parsed = JSON.parse(bytes.subarray(20, 20 + length).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : 'bad_json';
  } catch {
    return 'bad_json';
  }
}

/** The backend's checks, mirrored closely enough that the editor sees the same codes. */
export function inspect(bytes: Buffer, expect: 'model' | 'clip'): Inspection {
  const doc = readJson(bytes);
  if (typeof doc === 'string') return { ok: false, code: doc };
  const ext = (doc.extensions ?? {}) as Record<string, any>;
  if (expect === 'clip') {
    return ext.VRMC_vrm_animation && typeof ext.VRMC_vrm_animation === 'object'
      ? { ok: true, kind: 'clip' }
      : { ok: false, code: 'not_vrma' };
  }
  if (ext.VRMC_vrm && typeof ext.VRMC_vrm === 'object') {
    const vrm = ext.VRMC_vrm;
    if (!vrm.humanoid?.humanBones?.hips) return { ok: false, code: 'no_humanoid' };
    const presets = Object.keys(vrm.expressions?.preset ?? {});
    return {
      ok: true, kind: 'model', spec_version: '1.0',
      expressions: EMOTIONS.filter((e) => presets.includes(e)),
      meta: { spec_version: '1.0', title: vrm.meta?.name ?? null, authors: vrm.meta?.authors ?? [] },
    };
  }
  if (ext.VRM && typeof ext.VRM === 'object') {
    const vrm = ext.VRM;
    const bones: any[] = Array.isArray(vrm.humanoid?.humanBones) ? vrm.humanoid.humanBones : [];
    if (!bones.some((b) => b?.bone === 'hips')) return { ok: false, code: 'no_humanoid' };
    const groups: any[] = Array.isArray(vrm.blendShapeMaster?.blendShapeGroups) ? vrm.blendShapeMaster.blendShapeGroups : [];
    const present = new Set(groups.map((g) => VRM0_PRESETS[String(g?.presetName ?? '').toLowerCase()]).filter(Boolean));
    return {
      ok: true, kind: 'model', spec_version: '0.x',
      expressions: EMOTIONS.filter((e) => present.has(e)),
      meta: { spec_version: '0.x', title: vrm.meta?.title ?? null, authors: vrm.meta?.author ? [vrm.meta.author] : [] },
    };
  }
  return { ok: false, code: 'not_vrm' };
}
