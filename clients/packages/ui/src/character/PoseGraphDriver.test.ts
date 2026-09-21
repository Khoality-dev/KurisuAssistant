/**
 * The 2D adapter meets the driver contract (#238).
 *
 * The conformance cases come from `@kurisu/vrm/testing` and are the same
 * ones the VRM driver passes: a surface relies on every one of them. The
 * compositor underneath is the real one, over a recording context and tagged
 * fake images, exactly as in `CanvasCompositor.test.ts`; the adapter's own
 * additions — refusal, abort, supersession, no-ops — are what the cases see.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterDriver, ParsedCharacterConfig, PoseTree } from '@kurisu/models';
import { driverConformanceCases, IDLE_INPUT } from '@kurisu/vrm/testing';

vi.mock('../videocall/engine/ImageCache', () => ({
  getCachedImage: async (url: string) => ({ tag: url, naturalWidth: 400, naturalHeight: 600 }),
  clearImageCache: () => {},
}));
vi.mock('@kurisu/api', () => ({
  fetchAuthedBlob: vi.fn(),
  config: { apiBaseUrl: 'http://backend' },
}));

import { createPoseGraphDriver, POSE_CANVAS_HEIGHT, POSE_CANVAS_WIDTH, type PoseGraphDriver } from './PoseGraphDriver';

const tree = (): PoseTree => ({
  default_pose_ids: ['a'],
  nodes: [{
    id: 'a', name: 'a', type: 'pose', position: { x: 0, y: 0 },
    pose_config: {
      name: 'a',
      base_image_url: '/character-assets/1/a/base',
      left_eye: { patches: [] },
      right_eye: { patches: [] },
      mouth: { patches: [{ image_url: '/character-assets/1/a/mouth_0', x: 0, y: 0, width: 1, height: 1 }] },
    },
  }],
  edges: [],
});

const goodConfig: ParsedCharacterConfig = { kind: 'pose_graph', poseTree: tree(), vrm: null };
const badConfig: ParsedCharacterConfig = { kind: 'vrm', poseTree: null, vrm: null };
const treelessConfig: ParsedCharacterConfig = { kind: 'pose_graph', poseTree: null, vrm: null };

function fakeContext() {
  return { globalAlpha: 1, clearRect() {}, drawImage() {}, save() {}, restore() {}, translate() {} };
}

describe('PoseGraphDriver', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext() as unknown as CanvasRenderingContext2D);
    vi.stubGlobal('OffscreenCanvas', class { getContext() { return { drawImage() {} }; } });
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const makeDriver = () => createPoseGraphDriver(document.createElement('canvas'), { apiBaseUrl: () => 'http://backend' });
  const deps = () => ({ resolveAsset: async () => new ArrayBuffer(0), signal: new AbortController().signal });

  describe('the conformance cases every driver passes', () => {
    const cases = driverConformanceCases({
      makeDriver,
      goodConfig,
      badConfig,
      resolveAsset: async () => new ArrayBuffer(0),
      probe: (driver: CharacterDriver) => {
        const d = driver as PoseGraphDriver;
        return { loaded: d.loaded, framesDrawn: d.framesForwarded, mouthOpen: d.mouthOpen };
      },
    });
    for (const c of cases) {
      it(c.name, () => c.run());
    }
  });

  it('is a pose graph and sizes its backing store like the old renderer', () => {
    const canvas = document.createElement('canvas');
    const d = createPoseGraphDriver(canvas, { apiBaseUrl: () => 'http://backend' });
    expect(d.kind).toBe('pose_graph');
    expect([canvas.width, canvas.height]).toEqual([POSE_CANVAS_WIDTH, POSE_CANVAS_HEIGHT]);
    d.dispose();
  });

  it('refuses a pose-graph persona with no tree, readably', async () => {
    const d = makeDriver();
    await expect(d.load(treelessConfig, deps())).rejects.toThrow('no pose graph');
    expect(d.loaded).toBe(false);
    d.dispose();
  });

  it('forwards the frame to the compositor: mouth, thinking, gestures, faces', async () => {
    const d = makeDriver();
    await d.load(goodConfig, deps());
    d.update(16, { ...IDLE_INPUT, isPlaying: true, amplitude: 0.7, isThinking: true, gestures: ['wave'], faces: ['Khoa'] });
    expect(d.mouthOpen).toBe(0.7);
    d.update(16, IDLE_INPUT);
    expect(d.mouthOpen).toBe(0);
    expect(d.framesForwarded).toBe(2);
    d.dispose();
  });

  it('a load after dispose rejects rather than reviving the engine', async () => {
    const d = makeDriver();
    d.dispose();
    await expect(d.load(goodConfig, deps())).rejects.toThrow('disposed');
  });
});
