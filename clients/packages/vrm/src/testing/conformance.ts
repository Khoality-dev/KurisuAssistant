/**
 * What every `CharacterDriver` must survive, as plain cases.
 *
 * No test framework is imported here: each case throws when it fails, so the
 * same list runs under this package's vitest and under whatever suite the
 * 2D adapter (#238) lives in. A surface relies on these — StrictMode mounts
 * twice, a persona switch aborts a load in flight, a resize can land before
 * the first load — and a driver that breaks one breaks the surface.
 */
import type { CharacterDriver, DriverInput, ParsedCharacterConfig } from '@kurisu/models';

export interface ConformanceHarness {
  /** A fresh driver on a fresh canvas. */
  makeDriver(): CharacterDriver;
  /** A config `load` accepts. */
  goodConfig: ParsedCharacterConfig;
  /** A config `load` refuses (rejects with a readable message). */
  badConfig: ParsedCharacterConfig;
  resolveAsset: (url: string) => Promise<ArrayBuffer>;
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
      name: 'update before load is a no-op',
      run: async () => {
        const d = h.makeDriver();
        d.update(16, IDLE_INPUT);
        d.update(16, { ...IDLE_INPUT, isPlaying: true, amplitude: 0.5, gestures: ['wave'] });
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
      name: 'load resolves and update then draws',
      run: async () => {
        const d = h.makeDriver();
        await d.load(h.goodConfig, deps());
        d.resize(320, 480, 1);
        d.update(16, IDLE_INPUT);
        d.update(16, { ...IDLE_INPUT, isPlaying: true, amplitude: 0.8 });
        d.dispose();
      },
    },
    {
      name: 'a refused load rejects with a message and leaves the driver usable',
      run: async () => {
        const d = h.makeDriver();
        const error = await rejects(d.load(h.badConfig, deps()));
        assert(error.message.length > 0, 'the rejection carries no message');
        d.update(16, IDLE_INPUT);
        await d.load(h.goodConfig, deps());
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
      name: 'dispose is idempotent and update after it is a no-op',
      run: async () => {
        const d = h.makeDriver();
        await d.load(h.goodConfig, deps());
        d.dispose();
        d.dispose();
        d.update(16, IDLE_INPUT);
        d.resize(100, 100, 1);
      },
    },
    {
      name: 'an aborted load rejects with AbortError and dispose is fine',
      run: async () => {
        const d = h.makeDriver();
        const controller = new AbortController();
        controller.abort();
        const error = await rejects(d.load(h.goodConfig, { resolveAsset: h.resolveAsset, signal: controller.signal }));
        assert(error.name === 'AbortError', `expected AbortError, got ${error.name}: ${error.message}`);
        d.dispose();
      },
    },
    {
      name: 'loading twice (a persona switch) leaves one model and works',
      run: async () => {
        const d = h.makeDriver();
        await d.load(h.goodConfig, deps());
        await d.load(h.goodConfig, deps());
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
        d.update(16, IDLE_INPUT);
        d.dispose();
      },
    },
  ];
}
