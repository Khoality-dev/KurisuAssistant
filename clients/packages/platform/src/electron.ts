/**
 * The Electron host.
 *
 * **This is the only file in `packages/` allowed to name `window.electron`** —
 * `boundaries.test.ts` fails the build if another one does. Everything here is a
 * one-for-one forward to the preload bridge; behaviour belongs on the other side
 * of it, in `electron/`, or above it in the caller.
 */
import type { PlatformBridge } from './index';
import type { ElectronAPI } from './types';

function hostApi(): ElectronAPI | null {
  if (typeof window === 'undefined') return null;
  return (window as Window & { electron?: ElectronAPI }).electron ?? null;
}

/** The bridge for Electron, or `null` when this is not Electron. */
export function electronBridge(): PlatformBridge | null {
  const api = hostApi();
  if (!api) return null;

  return {
    platform: 'electron',
    os: api.platform,
    capabilities: {
      localFiles: true,
      hostTools: true,
      stdioMcp: true,
      hostApps: true,
      installer: true,
      autoUpdate: true,
      // The keychain can still be missing (a Linux box with no libsecret), and
      // then nothing persists. `credentials.isSecure()` is the runtime answer;
      // this flag only says the host has somewhere to try.
      secureCredentials: true,
      mcpEndpoint: true,
      characterWindow: true,
      transferProgress: true,
      configurableServer: true,
    },
    files: api.explorer,
    transfers: api.drive,
    credentials: api.credentials,
    characterWindow: api.characterWindow,
    hostTools: api.hostTools,
    mcp: api.mcp,
    mcpServer: api.mcpServer,
    appTools: api.appTools,
    extensions: api.extensions,
    openPath: (target) => api.openPath(target),
    onMCPToolsChanged: (cb) => api.onMCPToolsChanged(cb),
  };
}
