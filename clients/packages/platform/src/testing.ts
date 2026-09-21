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

export type FakeCharacterWindow = CharacterWindowAPI & {
  calls: CharacterWindowCall[];
  /**
   * Deliver an event to whatever subscribed with the matching `on*` — the
   * window's `ready`, a pushed session, a spoken sentence — so a test can play
   * the other renderer. The method is the subscription's name.
   */
  fire: (method: keyof CharacterWindowAPI & `on${string}`, data?: unknown) => void;
};

/**
 * A character window that records what the main renderer sends it, and keeps
 * the handlers the renderer subscribes so a test can fire them.
 *
 * Every member of the interface is here, so adding one to `CharacterWindowAPI`
 * is a type error until this fake learns it — the way a stub with only the
 * members one suite happened to call would not be.
 */
export function fakeCharacterWindow(): FakeCharacterWindow {
  const calls: CharacterWindowCall[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Handler = (data?: any) => void;
  const handlers = new Map<string, Set<Handler>>();
  const record = (method: string) => (data?: unknown) => { calls.push({ method, data }); };
  // `any` on the callback keeps one helper assignable to every `on*` member,
  // whose payloads differ; the fake records, it does not type-check them.
  const subscription = (method: string) => (cb: Handler) => {
    calls.push({ method });
    const set = handlers.get(method) ?? new Set<Handler>();
    set.add(cb);
    handlers.set(method, set);
    return () => { set.delete(cb); };
  };
  return {
    calls,
    fire: (method, data) => { for (const cb of handlers.get(method) ?? []) cb(data); },
    open: async () => { calls.push({ method: 'open' }); },
    close: async () => { calls.push({ method: 'close' }); },
    sendSession: record('sendSession'),
    onSession: subscription('onSession'),
    requestSession: () => { calls.push({ method: 'requestSession' }); },
    onSessionRequest: subscription('onSessionRequest'),
    sendSpeech: record('sendSpeech'),
    onSpeech: subscription('onSpeech'),
    sendSpeechSync: record('sendSpeechSync'),
    onSpeechSync: subscription('onSpeechSync'),
    sendFeed: record('sendFeed'),
    onFeed: subscription('onFeed'),
    sendPersonasUpdate: record('sendPersonasUpdate'),
    sendGestureUpdate: record('sendGestureUpdate'),
    sendFaceUpdate: record('sendFaceUpdate'),
    sendSubtitle: record('sendSubtitle'),
    onPersonasUpdate: subscription('onPersonasUpdate'),
    onGestureUpdate: subscription('onGestureUpdate'),
    onFaceUpdate: subscription('onFaceUpdate'),
    onSubtitle: subscription('onSubtitle'),
    onWindowClosed: subscription('onWindowClosed'),
    signalReady: () => { calls.push({ method: 'signalReady' }); },
    onCharacterReady: subscription('onCharacterReady'),
  };
}
