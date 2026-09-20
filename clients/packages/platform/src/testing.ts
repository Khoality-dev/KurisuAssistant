/**
 * One fake host, for every test that needs one.
 *
 * Three suites each grew their own `(window as any).electron = {...}` stub with
 * only the members that suite happened to call. That works until the interface
 * changes, at which point a stub that is missing the new member goes on passing
 * while the real thing would not. This one starts from the web bridge — every
 * capability off, every member absent — so a test says exactly what its host
 * can do and nothing is silently implied.
 */
import { setBridge, type Capabilities, type PlatformBridge } from './index';
import type { CharacterWindowAPI } from './types';
import { webBridge } from './web';

export interface FakeBridgeOptions extends Partial<Omit<PlatformBridge, 'capabilities'>> {
  capabilities?: Partial<Capabilities>;
}

/** A bridge that answers no to everything, plus whatever the test fills in. */
export function fakeBridge(overrides: FakeBridgeOptions = {}): PlatformBridge {
  const base = webBridge();
  const { capabilities, ...rest } = overrides;
  return { ...base, ...rest, capabilities: { ...base.capabilities, ...capabilities } };
}

/** Install a fake for one test. Pair it with `resetBridge()` in an afterEach. */
export function installBridge(overrides: FakeBridgeOptions = {}): PlatformBridge {
  const bridge = fakeBridge(overrides);
  setBridge(bridge);
  return bridge;
}

/** Forget the installed bridge, so the next resolve detects the real host. */
export function resetBridge(): void {
  setBridge(null);
}


/** What a recording character window saw, in the order it saw it. */
export interface CharacterWindowCall {
  method: string;
  data?: unknown;
}

/**
 * A character window that records what the main renderer sends it.
 *
 * Every member of the interface is here, so adding one to `CharacterWindowAPI`
 * is a type error until this fake learns it — the way a stub with only the
 * members one suite happened to call would not be.
 */
export function fakeCharacterWindow(): CharacterWindowAPI & { calls: CharacterWindowCall[] } {
  const calls: CharacterWindowCall[] = [];
  const record = (method: string) => (data?: unknown) => { calls.push({ method, data }); };
  const subscription = (method: string) => () => { calls.push({ method }); return () => {}; };
  return {
    calls,
    open: async () => { calls.push({ method: 'open' }); },
    close: async () => { calls.push({ method: 'close' }); },
    sendSession: record('sendSession'),
    onSession: subscription('onSession'),
    requestSession: () => { calls.push({ method: 'requestSession' }); },
    onSessionRequest: subscription('onSessionRequest'),
    sendAmplitude: record('sendAmplitude'),
    sendPersonasUpdate: record('sendPersonasUpdate'),
    sendGestureUpdate: record('sendGestureUpdate'),
    sendFaceUpdate: record('sendFaceUpdate'),
    sendSubtitle: record('sendSubtitle'),
    onAmplitude: subscription('onAmplitude'),
    onPersonasUpdate: subscription('onPersonasUpdate'),
    onGestureUpdate: subscription('onGestureUpdate'),
    onFaceUpdate: subscription('onFaceUpdate'),
    onSubtitle: subscription('onSubtitle'),
    onWindowClosed: subscription('onWindowClosed'),
    signalReady: () => { calls.push({ method: 'signalReady' }); },
    onCharacterReady: subscription('onCharacterReady'),
  };
}
