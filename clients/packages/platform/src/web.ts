/**
 * A browser tab.
 *
 * Everything here is absent, and that is the finished answer for most of it: a
 * page cannot read the machine it is displayed on, run a shell on it, spawn a
 * child process, or replace itself. The members that a browser *can* eventually
 * answer — drive transfers over XHR, a character panel rendered inline — are
 * left `null` until the app that needs them exists (#128), because a half-built
 * implementation nothing calls is worse than an honest "no".
 */
import type { PlatformBridge } from './index';

export function webBridge(): PlatformBridge {
  return {
    platform: 'web',
    os: null,
    capabilities: {
      localFiles: false,
      hostTools: false,
      stdioMcp: false,
      hostApps: false,
      installer: false,
      autoUpdate: false,
      secureCredentials: false,
      mcpEndpoint: false,
      characterWindow: false,
      transferProgress: false,
    },
    files: null,
    transfers: null,
    credentials: null,
    characterWindow: null,
    hostTools: null,
    mcp: null,
    mcpServer: null,
    appTools: null,
    extensions: null,
    openPath: async (target) => {
      window.open(target, '_blank', 'noopener,noreferrer');
      return '';
    },
    // Nothing here starts MCP servers, so the set of them never changes.
    onMCPToolsChanged: () => () => {},
  };
}
