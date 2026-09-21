/**
 * What the 2D engine does, pinned before anything wraps it (#238).
 *
 * `CanvasCompositor` is the only working character path and had no test. The
 * driver seam puts an adapter over its public surface without editing it, so
 * these cases record the behaviour that adapter — and the design that reuses
 * the same semantics for the 3D driver — relies on: which transition wins,
 * what an unknown condition does, that a gesture is consumed by one tick, how
 * a blink progresses through its patches, and one quirk worth knowing about:
 * an instant (video-less) transition returns to idle synchronously, so a
 * level-triggered edge can chain several hops inside one frame.
 *
 * The canvas, the images and the clock are all fakes: the engine's loop is
 * stepped by hand and its draw calls are read back from a recording context.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoseTree } from '@kurisu/models';

// Images arrive through the authenticated cache; here every URL is a tagged
// object so a draw call says which patch it drew.
vi.mock('./ImageCache', () => ({
  getCachedImage: async (url: string) => fakeImage(url),
  clearImageCache: () => {},
}));
vi.mock('@kurisu/api', () => ({ fetchAuthedBlob: vi.fn() }));

import { CanvasCompositor } from './CanvasCompositor';

interface FakeImage { tag: string; naturalWidth: number; naturalHeight: number }
function fakeImage(url: string): HTMLImageElement {
  const img: FakeImage = { tag: url.replace(/^.*\/character-assets\/1\//, ''), naturalWidth: 400, naturalHeight: 600 };
  return img as unknown as HTMLImageElement;
}

/** A 2D context that remembers what the last frame drew on it. */
function recordingContext() {
  const drawn: string[] = [];
  return {
    drawn,
    globalAlpha: 1,
    clearRect: () => { drawn.length = 0; },
    drawImage: (image: unknown) => { drawn.push((image as FakeImage).tag ?? 'canvas'); },
    save: () => {},
    restore: () => {},
    translate: () => {},
  };
}

const patch = (id: string, part: string, i: number) => ({
  image_url: `/character-assets/1/${id}/${part}_${i}`, x: 0, y: 0, width: 10, height: 10,
});
const pose = (id: string) => ({
  id,
  name: id,
  type: 'pose' as const,
  position: { x: 0, y: 0 },
  pose_config: {
    name: id,
    base_image_url: `/character-assets/1/${id}/base`,
    left_eye: { patches: [patch(id, 'left_eye', 0), patch(id, 'left_eye', 1)] },
    right_eye: { patches: [patch(id, 'right_eye', 0), patch(id, 'right_eye', 1)] },
    mouth: { patches: [patch(id, 'mouth', 0), patch(id, 'mouth', 1)] },
  },
});

type Cond = PoseTree['edges'][number]['transitions'][number]['conditions'][number];
const edge = (from: string, to: string, ...transitions: Cond[][]) => ({
  id: `${from}-${to}`,
  from_node_id: from,
  to_node_id: to,
  transitions: transitions.map((conditions) => ({ conditions })),
});

/**
 * A: the default. A→B on a wave or on thinking; A→C also on a wave, listed
 * second, so it never gets the chance; A→D on a condition type nothing knows;
 * A→E on a five-second timer (long enough to stay out of the other cases).
 * B→A on a thumbs-up or a known face; B→C on thinking. C and E are sinks.
 */
function tree(): PoseTree {
  return {
    default_pose_ids: ['A'],
    nodes: [pose('A'), pose('B'), pose('C'), pose('D'), pose('E')],
    edges: [
      edge('A', 'B', [{ type: 'gesture', value: 'wave' }], [{ type: 'thinking', value: true }]),
      edge('A', 'C', [{ type: 'gesture', value: 'wave' }]),
      edge('A', 'D', [{ type: 'weird' } as unknown as Cond]),
      edge('A', 'E', [{ type: 'random', min_interval_ms: 5000, max_interval_ms: 5000 }]),
      edge('B', 'A', [{ type: 'gesture', value: 'thumbs_up' }], [{ type: 'face', value: 'Khoa', visible: true }]),
      edge('B', 'C', [{ type: 'thinking', value: true }]),
    ],
  };
}

describe('CanvasCompositor, as it behaves today', () => {
  let ctx: ReturnType<typeof recordingContext>;
  let frame: ((now: number) => void) | null;
  let clock: number;
  let compositor: CanvasCompositor;

  const step = (ms = 16) => { clock += ms; frame?.(clock); };
  const currentPose = () => compositor.getPose()?.name ?? null;
  const eyes = () => ctx.drawn.filter((tag) => tag.includes('eye'));
  const mouth = () => ctx.drawn.filter((tag) => tag.includes('mouth'));

  beforeEach(async () => {
    ctx = recordingContext();
    clock = 0;
    frame = null;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx as unknown as CanvasRenderingContext2D);
    vi.stubGlobal('OffscreenCanvas', class {
      width = 0; height = 0;
      constructor(w: number, h: number) { this.width = w; this.height = h; }
      getContext() { return { drawImage: () => {} }; }
    });
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => { frame = cb; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => { frame = null; });
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    // Random 0: a blink waits exactly blinkMinInterval, a timer exactly its
    // minimum, and a default pose is the first listed.
    vi.spyOn(Math, 'random').mockReturnValue(0);

    compositor = new CanvasCompositor(document.createElement('canvas'));
    await compositor.loadPoseTree(tree(), 'http://backend');
    compositor.start();
  });

  afterEach(() => {
    compositor.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('starts on the default pose and draws its base image first', () => {
    step();
    expect(currentPose()).toBe('A');
    expect(ctx.drawn[0]).toBe('A/base');
  });

  it('the first matching transition in edge order wins, every time — never a random choice', () => {
    for (let i = 0; i < 20; i++) {
      compositor.setGestures(['wave']);
      step();
      expect(currentPose()).toBe('B');
      compositor.setGestures(['thumbs_up']);
      step();
      expect(currentPose()).toBe('A');
    }
  });

  it('a gesture is consumed by the tick that sees it, even when nothing matched', () => {
    compositor.setGestures(['wave']);
    step();
    expect(currentPose()).toBe('B');
    // At B nothing listens for a wave; the tick still clears it.
    compositor.setGestures(['wave']);
    step();
    expect(currentPose()).toBe('B');
    // Back at A by a face, which is level state: the stale wave must not fire A→B.
    compositor.setFaces(['Khoa']);
    step();
    expect(currentPose()).toBe('A');
    step();
    expect(currentPose()).toBe('A');
  });

  it('a face is level state, and a gesture stays live until the gesture pass of its tick', () => {
    compositor.setFaces(['Khoa']);
    compositor.setGestures(['wave']);
    step();
    // One frame, three hops: A→B on the wave (timer pass), B→A on the face
    // (thinking pass), A→B on the wave again (gesture pass — the wave is only
    // cleared after that pass).
    expect(currentPose()).toBe('B');
    step();
    // The face is still in view: B→A once more, and A holds.
    expect(currentPose()).toBe('A');
    step();
    expect(currentPose()).toBe('A');
    compositor.setFaces([]);
    compositor.setGestures(['wave']);
    step();
    expect(currentPose()).toBe('B');
  });

  it('an unknown condition type is false, so the edge never fires', () => {
    for (let i = 0; i < 500; i++) step();
    expect(currentPose()).not.toBe('D');
  });

  it('a random timer fires once its interval has elapsed, not before', () => {
    for (let t = 16; t < 5000; t += 16) step();
    expect(currentPose()).toBe('A');
    step(16);
    expect(currentPose()).toBe('E');
  });

  it('a level-triggered edge chains through several hops inside one frame', () => {
    // A→B on thinking, B→C on thinking: an instant transition returns to idle
    // synchronously and the same update evaluates again, so one frame with
    // isThinking lands two hops away.
    compositor.isThinking = true;
    step();
    expect(currentPose()).toBe('C');
    compositor.isThinking = false;
    step();
    expect(currentPose()).toBe('C');
  });

  it('blinks through half-closed, closed and back on the configured timings', () => {
    // Defaults: interval 2000 (random 0 → the minimum), close 100, hold 50, open 100.
    for (let t = 16; t <= 1984; t += 16) step();
    expect(eyes()).toEqual([]);                                   // open until 2000
    step(66);                                                     // 2050: the tick that starts closing still draws open
    expect(eyes()).toEqual([]);
    step(50);                                                     // 2100: halfway closed
    expect(eyes()).toEqual(['A/left_eye_0', 'A/right_eye_0']);
    step(50);                                                     // 2150: closed
    expect(eyes()).toEqual(['A/left_eye_1', 'A/right_eye_1']);
    step(50);                                                     // 2200: held closed, opening starts
    expect(eyes()).toEqual(['A/left_eye_1', 'A/right_eye_1']);
    step(50);                                                     // 2250: halfway open
    expect(eyes()).toEqual(['A/left_eye_0', 'A/right_eye_0']);
    step(50);                                                     // 2300: open
    expect(eyes()).toEqual([]);
  });

  it('the mouth patch follows amplitude only while audio plays', () => {
    compositor.mouthAmplitude = 0.9;
    step();
    expect(mouth()).toEqual([]);                    // not playing: closed
    compositor.isAudioPlaying = true;
    step();
    expect(mouth()).toEqual(['A/mouth_1']);         // round(0.9 × 2) = 2 → second patch
    compositor.mouthAmplitude = 0.3;
    step();
    expect(mouth()).toEqual(['A/mouth_0']);         // round(0.3 × 2) = 1
    compositor.mouthAmplitude = 0.1;
    step();
    expect(mouth()).toEqual([]);                    // round(0.2) = 0
  });

  it('clearPose empties the engine, and destroy is safe to call twice', () => {
    compositor.clearPose();
    step();
    expect(currentPose()).toBeNull();
    expect(ctx.drawn).toEqual([]);
    compositor.destroy();
    compositor.destroy();
  });
});
