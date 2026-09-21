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
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterDriver, DriverInput, ParsedCharacterConfig, PoseTree } from '@kurisu/models';
import { publishSpeech, pushGestures, resetCharacterFeed, setFaces, setThinking } from '@kurisu/state';

vi.mock('@kurisu/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kurisu/api')>()),
  fetchAuthedBytes: vi.fn(async () => new ArrayBuffer(0)),
}));

import { CharacterSurface } from './CharacterSurface';

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

  it('shows "No avatar" and makes no driver for a config nothing here can draw', async () => {
    render({ character: { kind: 'vrm', poseTree: null, vrm: null } });
    await settle();
    expect(container.textContent).toContain('No avatar');
    expect(drivers).toHaveLength(0);
  });
});
