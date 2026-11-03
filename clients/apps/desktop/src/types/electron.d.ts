/**
 * The preload bridge, as this renderer sees it.
 *
 * The shape itself lives in `@amadeus/platform` — a browser build has to answer
 * the same interface — so all this file does is say that under Electron the
 * global exists. Components still reach for `window.electron` directly; the
 * layers underneath them go through `resolveBridge()` instead.
 */
import type { ElectronAPI } from '@amadeus/platform';

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}

export {};
