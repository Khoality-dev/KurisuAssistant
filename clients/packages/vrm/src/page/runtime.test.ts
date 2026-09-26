import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { describe, expect, it } from 'vitest';
import type { DriverInput, DriverLoadDeps, ParsedCharacterConfig, VrmSettings } from '@kurisu/models';
import type { PageEvent } from './host';
import { createPageRuntime, subtitleHoldMs, type PageDriver, type PageStatus } from './runtime';

const FIXTURES = join(dirname(new URL(import.meta.url).pathname), 'fixtures');
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));

interface FakeDriver extends PageDriver {
  loads: Array<{ config: ParsedCharacterConfig; deps: DriverLoadDeps; resolve: () => void; reject: (e: Error) => void }>;
  updates: DriverInput[];
  configured: VrmSettings[];
  disposed: number;
  drawn: number;
}

function fakeDriver(): FakeDriver {
  const d: FakeDriver = {
    loads: [],
    updates: [],
    configured: [],
    disposed: 0,
    drawn: 0,
    load(config, deps) {
      return new Promise<void>((resolve, reject) => d.loads.push({ config, deps, resolve, reject }));
    },
    update(_dt, input) {
      d.updates.push(input);
      if (d.loads.length) d.drawn++;
    },
    resize() {},
    configure(settings) {
      d.configured.push(settings);
    },
    dispose() {
      d.disposed++;
    },
    snapshot() {
      return { framesDrawn: d.drawn };
    },
  };
  return d;
}

function harness() {
  const drivers: FakeDriver[] = [];
  const events: PageEvent[] = [];
  const statuses: PageStatus[] = [];
  const subtitles: Array<{ text: string; isUser: boolean; holdMs: number } | null> = [];
  const fetched: string[] = [];
  const runtime = createPageRuntime({
    createDriver: () => {
      const d = fakeDriver();
      drivers.push(d);
      return d;
    },
    fetchAsset: async (url) => {
      fetched.push(url);
      return new ArrayBuffer(8);
    },
    emit: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
    onSubtitle: (s) => subtitles.push(s),
  });
  return { runtime, drivers, events, statuses, subtitles, fetched };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const last = <T>(list: T[]): T | undefined => list[list.length - 1];

async function loaded() {
  const h = harness();
  h.runtime.receive(JSON.stringify(fixture('config')));
  h.drivers[0].loads[0].resolve();
  await flush();
  return h;
}

describe('the page runtime', () => {
  it('loads a VRM config through the host, fetching its root-relative URLs verbatim', async () => {
    const h = harness();
    h.runtime.receive(JSON.stringify(fixture('config')));
    expect(h.statuses).toEqual(['loading']);
    expect(h.drivers).toHaveLength(1);
    const load = h.drivers[0].loads[0];
    expect(load.config.kind).toBe('vrm');
    await load.deps.resolveAsset('/character-assets/1/vrm/model');
    expect(h.fetched).toEqual(['/character-assets/1/vrm/model']);
    load.resolve();
    await flush();
    expect(h.runtime.status).toBe('ready');
  });

  it('says first-frame once per load, after a frame has been drawn', async () => {
    const h = await loaded();
    expect(h.events.filter((e) => e.t === 'first-frame')).toHaveLength(0);
    h.runtime.frame(1000);
    h.runtime.frame(1016);
    h.runtime.frame(1033);
    expect(h.events.filter((e) => e.t === 'first-frame')).toHaveLength(1);
  });

  it('reports a failed load as a load error and a failed status, and does not throw', async () => {
    const h = harness();
    h.runtime.receive(fixture('config'));
    h.drivers[0].loads[0].reject(new Error('Model not found (404)'));
    await flush();
    expect(h.runtime.status).toBe('failed');
    expect(h.events).toContainEqual({ t: 'error', code: 'load', message: 'Model not found (404)' });
  });

  it('reports a malformed message as a message error instead of throwing', () => {
    const h = harness();
    expect(() => h.runtime.receive('{"t":"dance"}')).not.toThrow();
    expect(h.events).toEqual([{ t: 'error', code: 'message', message: 'unknown message type "dance"' }]);
  });

  it('shows no model for a null config, a 2D config or a VRM config without a model', () => {
    for (const character of [null, { kind: 'pose_graph', pose_tree: null }, { kind: 'vrm', vrm: { ...fixture('config').character.vrm, model: null } }]) {
      const h = harness();
      h.runtime.receive({ t: 'config', character, personaName: 'Kurisu' });
      expect(h.runtime.status).toBe('no-model');
      expect(h.drivers.flatMap((d) => d.loads)).toHaveLength(0);
    }
  });

  it('reconfigures without reloading when only settings change, and reloads for a new model', async () => {
    const h = await loaded();
    const config = fixture('config');
    config.character.vrm.camera.fov = 30;
    h.runtime.receive(config);
    expect(h.drivers[0].loads).toHaveLength(1);
    expect(last(h.drivers[0].configured)?.camera.fov).toBe(30);

    config.character.vrm.model.sha256 = 'f'.repeat(64);
    h.runtime.receive(config);
    expect(h.drivers[0].loads).toHaveLength(2);
    expect(h.runtime.status).toBe('loading');
  });

  it('aborts a load the next config supersedes', () => {
    const h = harness();
    const config = fixture('config');
    h.runtime.receive(config);
    config.character.vrm.model.sha256 = 'f'.repeat(64);
    h.runtime.receive(config);
    expect(h.drivers[0].loads[0].deps.signal.aborted).toBe(true);
  });

  it('drives the mouth from the spoken sentence on the wall clock', async () => {
    const h = await loaded();
    const speech = fixture('speech');
    h.runtime.receive(speech);
    const t0 = speech.segment.startedAt;
    h.runtime.frame(t0 + 3 * speech.segment.windowMs);
    const input = last(h.drivers[0].updates)!;
    expect(input.isPlaying).toBe(true);
    expect(input.amplitude).toBeCloseTo(0.7, 2);
    h.runtime.receive(fixture('speech-null'));
    h.runtime.frame(t0 + 5000);
    expect(last(h.drivers[0].updates)!.isPlaying).toBe(false);
  });

  it('applies a sentence cue once, when the audio reaches it', async () => {
    const h = await loaded();
    const speech = fixture('speech');
    h.runtime.receive(speech);
    const t0 = speech.segment.startedAt;
    h.runtime.frame(t0 + 500);
    expect(last(h.drivers[0].updates)!.cue).toBeNull();
    h.runtime.frame(t0 + 1150);
    expect(last(h.drivers[0].updates)!.cue).toEqual({ emotion: 'happy', hold_ms: null });
    h.runtime.frame(t0 + 1200);
    expect(last(h.drivers[0].updates)!.cue).toBeNull();
  });

  it('hands each gesture burst to the driver once, and ignores a replayed seq', async () => {
    const h = await loaded();
    h.runtime.receive(fixture('gestures'));
    h.runtime.receive(fixture('gestures'));
    h.runtime.frame(1);
    h.runtime.frame(2);
    const bursts = h.drivers[0].updates.map((u) => u.gestures).filter((g) => g.length);
    expect(bursts).toEqual([['wave', 'open_palm']]);
  });

  it('keeps faces and thinking as level state', async () => {
    const h = await loaded();
    h.runtime.receive(fixture('faces'));
    h.runtime.receive(fixture('feed'));
    h.runtime.frame(1);
    h.runtime.frame(2);
    for (const u of h.drivers[0].updates) {
      expect(u.faces).toEqual(['Khoa', 'Unknown']);
      expect(u.isThinking).toBe(true);
    }
  });

  it('rests on the resting emotion, before and after the model loads', async () => {
    const h = harness();
    h.runtime.receive(fixture('resting'));
    h.runtime.receive(fixture('config'));
    expect(h.drivers[0].loads[0].config.vrm?.emotion.default_expression).toBe('relaxed');
    h.drivers[0].loads[0].resolve();
    await flush();
    h.runtime.receive({ t: 'resting', emotion: 'sad' });
    expect(last(h.drivers[0].configured)?.emotion.default_expression).toBe('sad');
  });

  it('passes a subtitle on with how long to hold it', () => {
    const h = harness();
    h.runtime.receive(fixture('subtitle'));
    expect(h.subtitles).toEqual([{ text: 'Hello there.', isUser: false, holdMs: 1800 }]);
  });

  it('holds a subtitle with no duration for the character window\'s reading time', () => {
    expect(subtitleHoldMs('one two', null)).toBe(1500);
    expect(subtitleHoldMs('one two three four five six', null)).toBe(2100);
    expect(subtitleHoldMs('anything', 900)).toBe(900);
  });

  it('lets go of the driver on dispose and ignores what arrives after', async () => {
    const h = await loaded();
    h.runtime.dispose();
    expect(h.drivers[0].disposed).toBe(1);
    h.runtime.receive(fixture('config'));
    h.runtime.frame(5);
    expect(h.drivers).toHaveLength(1);
  });
});
