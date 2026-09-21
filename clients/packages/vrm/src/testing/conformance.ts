/**
 * What every `CharacterDriver` must survive, as plain cases that look.
 *
 * No test framework is imported here: each case throws when it fails, so the
 * same list runs under this package's vitest and under whatever suite the
 * 2D adapter (#238) lives in. A surface relies on these — StrictMode mounts
 * twice, a persona switch aborts a load in flight, a resize can land before
 * the first load — and a driver that breaks one breaks the surface.
 *
 * The harness hands over a `probe` so the cases can see what a driver did,
 * not only that it did not throw: a driver whose `load` resolves and whose
 * `update` draws nothing fails here, as it should.
 */
import type { CharacterDriver, DriverInput, ParsedCharacterConfig } from '@kurisu/models';

/** What a case may ask a driver about itself. */
export interface DriverProbe {
  /** A model is held and would be drawn. */
  loaded: boolean;
  /** Frames rendered since the driver was made. */
  framesDrawn: number;
  /** The mouth's main opening this frame, 0..1, if the driver has a mouth. */
  mouthOpen?: number;
}

export interface ConformanceHarness {
  /** A fresh driver on a fresh canvas. */
  makeDriver(): CharacterDriver;
  /** A config `load` accepts. */
  goodConfig: ParsedCharacterConfig;
  /** A config `load` refuses (rejects with a readable message). */
  badConfig: ParsedCharacterConfig;
  resolveAsset: (url: string) => Promise<ArrayBuffer>;
  /** How to look inside a driver this harness made. */
  probe(driver: CharacterDriver): DriverProbe;
}

export interface ConformanceCase {
  name: string;
  run: () => Promise<void>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export const IDLE_INPUT: DriverInput = { amplitude: 0, isPlaying: false, isThinking: false, gestures: [], faces: [], cue: null };

async function rejects(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
  throw new Error('expected the promise to reject');
}

export function driverConformanceCases(h: ConformanceHarness): ConformanceCase[] {
  const deps = () => ({ resolveAsset: h.resolveAsset, signal: new AbortController().signal });
  return [
    {
      name: 'update before load is a no-op and draws nothing',
      run: async () => {
        const d = h.makeDriver();
        d.update(16, IDLE_INPUT);
        d.update(16, { ...IDLE_INPUT, isPlaying: true, amplitude: 0.5, gestures: ['wave'] });
        assert(!h.probe(d).loaded, 'nothing was loaded, yet the driver says it holds a model');
        assert(h.probe(d).framesDrawn === 0, 'a driver with no model drew a frame');
        d.dispose();
      },
    },
    {
      name: 'resize before load does not throw',
      run: async () => {
        const d = h.makeDriver();
        d.resize(320, 480, 2);
        d.resize(1, 1, 1);
        d.dispose();
      },
    },
    {
      name: 'load resolves, holds the model, and update then draws',
      run: async () => {
        const d = h.makeDriver();
        await d.load(h.goodConfig, deps());
        assert(h.probe(d).loaded, 'load resolved but the driver holds no model');
        d.resize(320, 480, 1);
        d.update(16, IDLE_INPUT);
        d.update(16, { ...IDLE_INPUT, isPlaying: true, amplitude: 0.8 });
        assert(h.probe(d).framesDrawn === 2, `two updates drew ${h.probe(d).framesDrawn} frames`);
        d.dispose();
      },
    },
    {
      name: 'speech opens the mouth and silence closes it',
      run: async () => {
        const d = h.makeDriver();
        await d.load(h.goodConfig, deps());
        for (let i = 0; i < 30; i++) d.update(16, { ...IDLE_INPUT, isPlaying: true, amplitude: 0.9 });
        const open = h.probe(d).mouthOpen;
        if (open !== undefined) {
          assert(open > 0.3, `the mouth stayed at ${open} through 0.9 of amplitude`);
          for (let i = 0; i < 60; i++) d.update(16, IDLE_INPUT);
          assert((h.probe(d).mouthOpen ?? 0) === 0, 'the mouth did not close in silence');
        }
        d.dispose();
      },
    },
    {
      name: 'a refused load rejects with a message and leaves the driver empty, not broken',
      run: async () => {
        const d = h.makeDriver();
        await d.load(h.goodConfig, deps());
        const error = await rejects(d.load(h.badConfig, deps()));
        assert(error.message.length > 0, 'the rejection carries no message');
        assert(!h.probe(d).loaded, 'a refused load left the previous model in place');
        const before = h.probe(d).framesDrawn;
        d.update(16, IDLE_INPUT);
        assert(h.probe(d).framesDrawn === before, 'an empty driver drew a frame');
        await d.load(h.goodConfig, deps());
        assert(h.probe(d).loaded, 'the driver could not load again after a refusal');
        d.update(16, IDLE_INPUT);
        d.dispose();
      },
    },
    {
      name: 'dispose after a failed load does not throw',
      run: async () => {
        const d = h.makeDriver();
        await rejects(d.load(h.badConfig, deps()));
        d.dispose();
      },
    },
    {
      name: 'dispose releases the model, is idempotent, and update after it is a no-op',
      run: async () => {
        const d = h.makeDriver();
        await d.load(h.goodConfig, deps());
        d.dispose();
        d.dispose();
        assert(!h.probe(d).loaded, 'a disposed driver still holds its model');
        const before = h.probe(d).framesDrawn;
        d.update(16, IDLE_INPUT);
        d.resize(100, 100, 1);
        assert(h.probe(d).framesDrawn === before, 'a disposed driver drew a frame');
      },
    },
    {
      name: 'an aborted load rejects with AbortError, holds nothing, and dispose is fine',
      run: async () => {
        const d = h.makeDriver();
        const controller = new AbortController();
        controller.abort();
        const error = await rejects(d.load(h.goodConfig, { resolveAsset: h.resolveAsset, signal: controller.signal }));
        assert(error.name === 'AbortError', `expected AbortError, got ${error.name}: ${error.message}`);
        assert(!h.probe(d).loaded, 'an aborted load left a model behind');
        d.dispose();
      },
    },
    {
      name: 'a load aborted in flight rejects with AbortError and the next load still works',
      run: async () => {
        const d = h.makeDriver();
        const controller = new AbortController();
        const first = d.load(h.goodConfig, { resolveAsset: h.resolveAsset, signal: controller.signal });
        controller.abort();
        const error = await rejects(first);
        assert(error.name === 'AbortError', `expected AbortError, got ${error.name}: ${error.message}`);
        await d.load(h.goodConfig, deps());
        assert(h.probe(d).loaded, 'the driver could not load after an in-flight abort');
        d.dispose();
      },
    },
    {
      name: 'StrictMode: load, dispose, and load again on a fresh driver all resolve',
      run: async () => {
        const first = h.makeDriver();
        const controller = new AbortController();
        const pending = first.load(h.goodConfig, { resolveAsset: h.resolveAsset, signal: controller.signal });
        controller.abort();
        first.dispose();
        await pending.catch(() => undefined);
        const second = h.makeDriver();
        await second.load(h.goodConfig, deps());
        assert(h.probe(second).loaded, 'the second mount could not load what the first abandoned');
        second.update(16, IDLE_INPUT);
        second.dispose();
      },
    },
    {
      name: 'loading twice (a persona switch) leaves one model and works',
      run: async () => {
        const d = h.makeDriver();
        await d.load(h.goodConfig, deps());
        await d.load(h.goodConfig, deps());
        assert(h.probe(d).loaded, 'the second load left no model');
        d.update(16, IDLE_INPUT);
        d.dispose();
      },
    },
    {
      name: 'a second load started while the first is in flight wins',
      run: async () => {
        const d = h.makeDriver();
        const first = d.load(h.goodConfig, deps());
        const second = d.load(h.goodConfig, deps());
        await second;
        await first.catch(() => undefined);
        assert(h.probe(d).loaded, 'the winning load left no model');
        d.update(16, IDLE_INPUT);
        assert(h.probe(d).framesDrawn === 1, 'one update after the race did not draw exactly one frame');
        d.dispose();
      },
    },
  ];
}
