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
