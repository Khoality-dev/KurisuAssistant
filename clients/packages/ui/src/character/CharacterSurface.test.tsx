/**
 * The surface samples the feed and drives whatever driver it holds (#238).
 *
 * A fake driver records what it was told each frame; the frame loop is
 * stepped by hand; the feed is written the way the producers write it. What
 * is pinned: the mouth comes from the sentence's curve on the surface's own
 * clock, thinking and speech reach only the active persona, a gesture burst
 * is taken once, a config edit with the same shape reloads, a routine session
 * bump does not, a failed load retries on the next one, and unmounting
 * disposes.
 */
import { act, StrictMode } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterDriver, DriverInput, ParsedCharacterConfig, PoseTree, VrmAssetRef, VrmSettings } from '@kurisu/models';
import { publishSpeech, pushGestures, resetCharacterFeed, setFaces, setThinking } from '@kurisu/state';

vi.mock('@kurisu/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kurisu/api')>()),
  fetchAuthedBytes: vi.fn(async () => new ArrayBuffer(0)),
}));

import { fetchAuthedBytes } from '@kurisu/api';
import { CharacterSurface, failureBody, SURFACE_TEXT, type VrmModule } from './CharacterSurface';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const tree = (base: string): PoseTree => ({
  default_pose_ids: ['a'],
  nodes: [{
    id: 'a', name: 'a', type: 'pose', position: { x: 0, y: 0 },
    pose_config: { name: 'a', base_image_url: base, left_eye: { patches: [] }, right_eye: { patches: [] }, mouth: { patches: [] } },
  }],
  edges: [],
});
const poseGraph = (base = '/character-assets/1/a/base'): ParsedCharacterConfig => ({ kind: 'pose_graph', poseTree: tree(base), vrm: null });

interface FakeDriver extends CharacterDriver {
  inputs: DriverInput[];
  loads: ParsedCharacterConfig[];
  disposed: number;
  failNext: boolean;
}

function fakeDriver(): FakeDriver {
  const d: FakeDriver = {
    kind: 'pose_graph',
    inputs: [],
    loads: [],
    disposed: 0,
    failNext: false,
    async load(config) {
      d.loads.push(config);
      if (d.failNext) { d.failNext = false; throw new Error('nope'); }
    },
    update(_dt, input) { d.inputs.push(input); },
    resize() {},
    dispose() { d.disposed++; },
  };
  return d;
}

let container: HTMLDivElement;
let root: Root;
let drivers: FakeDriver[];
let frame: (() => void) | null;
let clock: number;

const makeDriver = () => { const d = fakeDriver(); drivers.push(d); return d; };
const now = () => clock;

function render(props: Partial<React.ComponentProps<typeof CharacterSurface>>) {
  act(() => {
    root.render(<CharacterSurface character={poseGraph()} active receivesStimuli makeDriver={makeDriver} now={now} {...props} />);
  });
}
async function settle() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
function step(ms = 16) { clock += ms; act(() => { frame?.(); }); }
const last = () => drivers[drivers.length - 1];
const lastInput = () => last().inputs[last().inputs.length - 1];

describe('CharacterSurface', () => {
  beforeEach(() => {
    resetCharacterFeed();
    drivers = [];
    frame = null;
    clock = 10_000;
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { frame = cb; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => { frame = null; });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('makes one driver, loads the config once, and disposes it when there is nothing left to draw', async () => {
    render({});
    await settle();
    expect(drivers).toHaveLength(1);
    expect(last().loads).toHaveLength(1);
    render({ character: null });
    expect(last().disposed).toBe(1);
    expect(frame).toBeNull();
    expect(drivers).toHaveLength(1);
  });

  it('drives the mouth from the sentence on its own clock, and closes it when speech ends', async () => {
    render({});
    await settle();
    publishSpeech({ text: 'hi', startedAt: clock, durationMs: 400, windowMs: 100, curve: [0, 1, 1, 0], cues: [] });
    step(50);
    expect(lastInput()).toMatchObject({ amplitude: 0.5, isPlaying: true });
    step(100);
    expect(lastInput()).toMatchObject({ amplitude: 1, isPlaying: true });
    publishSpeech(null);
    step();
    expect(lastInput()).toMatchObject({ amplitude: 0, isPlaying: false });
  });

  it('only the active persona hears speech and thinking; stimuli follow receivesStimuli', async () => {
    render({ active: false, receivesStimuli: false });
    await settle();
    publishSpeech({ text: 'hi', startedAt: clock, durationMs: 400, windowMs: 100, curve: [1, 1, 1, 1], cues: [] });
    setThinking(true);
    setFaces(['Khoa']);
    pushGestures(['wave']);
    step(50);
    expect(lastInput()).toEqual({ amplitude: 0, isPlaying: false, isThinking: false, gestures: [], faces: [], cue: null });
    render({ active: true, receivesStimuli: true });
    step(50);
    expect(lastInput()).toMatchObject({ amplitude: 1, isPlaying: true, isThinking: true, faces: ['Khoa'], gestures: [] });
  });

  it('takes a gesture burst once', async () => {
    render({});
    await settle();
    pushGestures(['wave']);
    step();
    expect(lastInput()?.gestures).toEqual(['wave']);
    step();
    expect(lastInput()?.gestures).toEqual([]);
    pushGestures(['thumbs_up']);
    step();
    expect(lastInput()?.gestures).toEqual(['thumbs_up']);
  });

  it('reloads when the config content changes, not when only its identity does', async () => {
    render({ character: poseGraph() });
    await settle();
    render({ character: poseGraph() });
    await settle();
    expect(last().loads).toHaveLength(1);
    render({ character: poseGraph('/character-assets/1/b/base') });
    await settle();
    expect(last().loads).toHaveLength(2);
  });

  it('retries a failed load on the next session bump, and ignores a bump otherwise', async () => {
    render({ retryToken: 0 });
    await settle();
    expect(last().loads).toHaveLength(1);
    render({ retryToken: 1 });
    await settle();
    expect(last().loads).toHaveLength(1);
    last().failNext = true;
    render({ character: poseGraph('/character-assets/1/c/base'), retryToken: 1 });
    await settle();
    expect(last().loads).toHaveLength(2);
    render({ character: poseGraph('/character-assets/1/c/base'), retryToken: 2 });
    await settle();
    expect(last().loads).toHaveLength(3);
  });

  it('shows "No avatar" and makes no driver for a pose graph with nothing to draw', async () => {
    render({ character: { kind: 'pose_graph', poseTree: null, vrm: null } });
    await settle();
    expect(container.textContent).toContain(SURFACE_TEXT.noAvatar);
    expect(drivers).toHaveLength(0);
  });
});

// ─── A VRM persona (#240) ───

const MODEL = {
  url: '/character-assets/1/vrm/model',
  sha256: 'a'.repeat(64),
  bytes: 18_400_000,
  uploaded_at: '2026-09-21T00:00:00Z',
  filename: 'kurisu_v2.vrm',
} as VrmAssetRef;

const vrmPersona = (model: VrmAssetRef | null = MODEL): ParsedCharacterConfig => ({
  kind: 'vrm',
  poseTree: null,
  vrm: {
    model,
    clips: [],
    reactions: [],
    idle: {} as VrmSettings['idle'],
    emotion: {} as VrmSettings['emotion'],
    camera: { target: 'upper_body', fov: 24, offset_y: 0, background: '#1E2230' },
  },
});

/** A VRM driver whose load asks for the model the way the real one does. */
function vrmDriver(behaviour: 'pending' | 'resolve' | Error = 'resolve'): FakeDriver {
  const d = fakeDriver();
  (d as { kind: string }).kind = 'vrm';
  d.load = async (config, deps) => {
    d.loads.push(config);
    await deps.resolveAsset(config.vrm!.model!.url);
    if (behaviour instanceof Error) throw behaviour;
  };
  return d;
}

describe('CharacterSurface with a VRM persona', () => {
  const fetchMock = vi.mocked(fetchAuthedBytes);

  beforeEach(() => {
    resetCharacterFeed();
    drivers = [];
    frame = null;
    clock = 10_000;
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { frame = cb; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => { frame = null; });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new ArrayBuffer(0));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const vrmMaker = (behaviour?: 'pending' | 'resolve' | Error) => () => { const d = vrmDriver(behaviour); drivers.push(d); return d; };

  it('on a display without WebGL says so, and never imports the engine', async () => {
    const importVrm = vi.fn(async () => { throw new Error('the engine must not load'); });
    // No `probe` and no `makeDriver`: the real probe, under happy-dom, whose getContext is null.
    act(() => {
      root.render(<CharacterSurface character={vrmPersona()} active receivesStimuli importVrm={importVrm} now={now} />);
    });
    await settle();
    expect(container.textContent).toContain(SURFACE_TEXT.noGl);
    expect(importVrm).not.toHaveBeenCalled();
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('imports the engine once the display passes the probe, and loads the model through it', async () => {
    const created: FakeDriver[] = [];
    const importVrm = vi.fn(async () => ({
      createVrmDriver: () => { const d = vrmDriver(); created.push(d); return d as never; },
    }));
    act(() => {
      root.render(<CharacterSurface character={vrmPersona()} active receivesStimuli importVrm={importVrm} probe={() => true} now={now} />);
    });
    await settle();
    await settle();
    expect(importVrm).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    expect(created[0].loads).toHaveLength(1);
    // The ref as stored: fetchAuthedBytes places a root-relative path on the
    // backend for every caller (authedFetch.test.ts, #298).
    expect(fetchMock.mock.calls[0][0]).toBe(MODEL.url);
  });

  it('while the model downloads, says how far it has got', async () => {
    fetchMock.mockImplementation((_url, _init, onProgress) => {
      onProgress?.(12_100_000, 18_400_000);
      return new Promise<ArrayBuffer>(() => {});
    });
    render({ character: vrmPersona(), makeDriver: vrmMaker('pending'), probe: () => true });
    await settle();
    expect(container.textContent).toContain(SURFACE_TEXT.loading);
    expect(container.textContent).toContain('12.1 of 18.4 MB');
  });

  it('when the download fails, names the file, says what happened, and tries again on request', async () => {
    const network = new TypeError('Failed to fetch');
    render({ character: vrmPersona(), makeDriver: vrmMaker(network), probe: () => true });
    await settle();
    expect(container.textContent).toContain(SURFACE_TEXT.failedTitle('kurisu_v2.vrm'));
    expect(container.textContent).toContain(SURFACE_TEXT.failedNetwork);
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === SURFACE_TEXT.tryAgain)!;
    act(() => { button.click(); });
    await settle();
    expect(last().loads).toHaveLength(2);
  });

  it('tries a failed download again when the connection comes back', async () => {
    render({ character: vrmPersona(), makeDriver: vrmMaker(new TypeError('Failed to fetch')), probe: () => true });
    await settle();
    act(() => { window.dispatchEvent(new Event('online')); });
    await settle();
    expect(last().loads).toHaveLength(2);
  });

  it("shows the loader's own words for a file it could not read", async () => {
    const unreadable = Object.assign(new Error('This file is not a VRM model.'), { name: 'VrmLoadError' });
    render({ character: vrmPersona(), makeDriver: vrmMaker(unreadable), probe: () => true });
    await settle();
    expect(container.textContent).toContain('This file is not a VRM model.');
    expect(container.textContent).not.toContain(SURFACE_TEXT.failedNetwork);
  });

  it('with no model yet, says where to upload one and makes no driver', async () => {
    render({ character: vrmPersona(null), makeDriver: vrmMaker(), personaName: 'Kurisu', probe: () => true });
    await settle();
    expect(container.textContent).toContain(SURFACE_TEXT.noModelTitle);
    expect(container.textContent).toContain('Upload one in Settings → Personas → Kurisu → Set up 3D character.');
    expect(drivers).toHaveLength(0);
  });

  it('once loaded, shows the stage on its own backdrop and no notice', async () => {
    render({ character: vrmPersona(), makeDriver: vrmMaker(), probe: () => true });
    await settle();
    const box = container.querySelector('[data-testid="character-surface"]') as HTMLElement;
    expect(box.dataset.status).toBe('ready');
    expect(box.style.background).toMatch(/1e2230|rgb\(30, 34, 48\)/i);
    expect(container.textContent).not.toContain(SURFACE_TEXT.loading);
  });
});

describe('CharacterSurface when making the driver or a load goes wrong', () => {
  beforeEach(() => {
    resetCharacterFeed();
    drivers = [];
    frame = null;
    clock = 10_000;
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { frame = cb; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => { frame = null; });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(fetchAuthedBytes).mockImplementation(async () => new ArrayBuffer(0));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const status = () => (container.querySelector('[data-testid="character-surface"]') as HTMLElement).dataset.status;
  const tryAgain = () => [...container.querySelectorAll('button')].find((b) => b.textContent === SURFACE_TEXT.tryAgain)!;

  it('an engine chunk that failed to import is imported again by "Try again", not left failed for good', async () => {
    const created: FakeDriver[] = [];
    const importVrm = vi.fn()
      .mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'))
      .mockResolvedValue({ createVrmDriver: () => { const d = vrmDriver(); created.push(d); return d as never; } });
    act(() => {
      root.render(<CharacterSurface character={vrmPersona()} active receivesStimuli importVrm={importVrm} probe={() => true} now={now} />);
    });
    await settle();
    expect(status()).toBe('failed');
    // Not a network failure, so not promised a retry on reconnect.
    expect(container.textContent).toContain(SURFACE_TEXT.failedGeneric);

    act(() => { tryAgain().click(); });
    await settle();
    await settle();
    expect(importVrm).toHaveBeenCalledTimes(2);
    expect(created).toHaveLength(1);
    expect(created[0].loads).toHaveLength(1);
    expect(status()).toBe('ready');
  });

  it('a session arriving after the engine failed makes the driver again', async () => {
    const importVrm = vi.fn()
      .mockRejectedValueOnce(new Error('chunk 404'))
      .mockResolvedValue({ createVrmDriver: () => vrmDriver() as never });
    const at = (retryToken: number) => act(() => {
      root.render(<CharacterSurface character={vrmPersona()} active receivesStimuli importVrm={importVrm} probe={() => true} now={now} retryToken={retryToken} />);
    });
    at(0);
    await settle();
    expect(status()).toBe('failed');
    at(1);
    await settle();
    await settle();
    expect(importVrm).toHaveBeenCalledTimes(2);
    expect(status()).toBe('ready');
  });

  it('a superseded load that rejects after the config changed does not show "failed"', async () => {
    let rejectFirst: (e: unknown) => void = () => {};
    const d = fakeDriver();
    (d as { kind: string }).kind = 'vrm';
    d.load = (config) => {
      d.loads.push(config);
      if (d.loads.length === 1) return new Promise<void>((_, reject) => { rejectFirst = reject; });
      return Promise.resolve();
    };
    const makeOne = () => d;
    render({ character: vrmPersona(), makeDriver: makeOne, probe: () => true });
    await settle();
    render({ character: vrmPersona({ ...MODEL, sha256: 'b'.repeat(64) }), makeDriver: makeOne, probe: () => true });
    await settle();
    expect(status()).toBe('ready');
    rejectFirst(new TypeError('Failed to fetch'));
    await settle();
    expect(status()).toBe('ready');
    expect(container.textContent).not.toContain(SURFACE_TEXT.failedNetwork);
  });

  it('under StrictMode, a driver that arrives for the discarded first mount is disposed, and one stays live', async () => {
    const created: FakeDriver[] = [];
    let release: () => void = () => {};
    const engine = new Promise<VrmModule>((resolve) => {
      release = () => resolve({ createVrmDriver: () => { const dr = vrmDriver(); created.push(dr); return dr as never; } });
    });
    const importVrm = vi.fn(() => engine);
    act(() => {
      root.render(
        <StrictMode>
          <CharacterSurface character={vrmPersona()} active receivesStimuli importVrm={importVrm} probe={() => true} now={now} />
        </StrictMode>,
      );
    });
    release();
    await settle();
    await settle();
    expect(created).toHaveLength(2);
    expect(created.filter((dr) => dr.disposed === 1)).toHaveLength(1);
    const live = created.find((dr) => dr.disposed === 0)!;
    expect(live.loads).toHaveLength(1);
    expect(status()).toBe('ready');
  });
});

describe('failureBody', () => {
  it('promises a retry on reconnect only for a failure of the connection itself', () => {
    expect(failureBody(new TypeError('Failed to fetch'))).toBe(SURFACE_TEXT.failedNetwork);
    expect(failureBody(Object.assign(new Error('x'), { name: 'DownloadInterruptedError' }))).toBe(SURFACE_TEXT.failedNetwork);
  });
  it('reads a 404 as a file the server no longer has', () => {
    expect(failureBody(Object.assign(new Error('x'), { name: 'AssetRequestError', status: 404 }))).toBe(SURFACE_TEXT.failedMissing);
  });
  it('gives a refusal, a failed chunk and a renderer failure the generic sentence', () => {
    for (const status of [401, 403, 500, 503]) {
      expect(failureBody(Object.assign(new Error('x'), { name: 'AssetRequestError', status }))).toBe(SURFACE_TEXT.failedGeneric);
    }
    expect(failureBody(new Error('Failed to fetch dynamically imported module'))).toBe(SURFACE_TEXT.failedGeneric);
    expect(failureBody(new Error('Error creating WebGL context.'))).toBe(SURFACE_TEXT.failedGeneric);
  });
  it("keeps a VrmLoadError's own words", () => {
    expect(failureBody(Object.assign(new Error('This file is not a VRM model.'), { name: 'VrmLoadError' }))).toBe('This file is not a VRM model.');
  });
});
