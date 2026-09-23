/**
 * The smallest files the character store accepts, built in code (#236).
 *
 * Not read from disk: the standalone mock is esbuild-bundled into
 * `dist-mock/cli.js`, where a file path relative to this module would resolve
 * under `dist-mock/` and find nothing. A glTF binary is a 12-byte header and a
 * JSON chunk; that is all the backend's validation reads, and all a spec needs
 * to exercise upload, serving, the ETag and a 304. Nothing here renders — a
 * renderer given these gets a skeleton with no meshes.
 */
import { createHash } from 'crypto';

const GLTF_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;

/** A glTF 2.0 binary whose only chunk is `document`, padded to four bytes. */
export function buildGlb(document: unknown): Buffer {
  let json: Buffer = Buffer.from(JSON.stringify(document), 'utf8');
  const pad = (4 - (json.length % 4)) % 4;
  if (pad) json = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLTF_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length, 8);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(json.length, 0);
  chunkHeader.writeUInt32LE(CHUNK_JSON, 4);
  return Buffer.concat([header, chunkHeader, json]);
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A VRM 1.0 model: a humanoid with hips and all six preset expressions. */
export const VRM_MODEL_BYTES = buildGlb({
  asset: { version: '2.0', generator: 'kurisu mock' },
  extensionsUsed: ['VRMC_vrm'],
  extensions: {
    VRMC_vrm: {
      specVersion: '1.0',
      meta: { name: 'Mock Kurisu', authors: ['mock'], licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'onlyAuthor', commercialUsage: 'personalNonProfit' },
      humanoid: { humanBones: { hips: { node: 0 } } },
      expressions: { preset: { happy: {}, angry: {}, sad: {}, relaxed: {}, surprised: {}, neutral: {} } },
    },
  },
  nodes: [{ name: 'hips' }],
});

export const VRM_MODEL_SHA256 = sha256Hex(VRM_MODEL_BYTES);

/** A VRMA clip. */
export const VRMA_CLIP_BYTES = buildGlb({
  asset: { version: '2.0', generator: 'kurisu mock' },
  extensionsUsed: ['VRMC_vrm_animation'],
  extensions: { VRMC_vrm_animation: { specVersion: '1.0' } },
});

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
