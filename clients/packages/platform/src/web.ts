/**
 * A browser tab.
 *
 * Everything here is absent, and that is the finished answer for most of it: a
 * page cannot read the machine it is displayed on, run a shell on it, spawn a
 * child process, or replace itself. The members that a browser *can* eventually
 * answer, drive transfers over XHR, are left `null` until the app that needs
 * them exists (#128), because a half-built implementation nothing calls is
 * worse than an honest "no". The character needs nothing from the host: its
 * panel renders inline in the chat column on every host (#241), and
 * `characterWindow` only says whether it can pop out.
 */
import type { PlatformBridge } from './index';

export function webBridge(): PlatformBridge {
  return {
    platform: 'web',
    os: null,
    // A page the backend serves has no release of its own; see PlatformBridge.
    appVersion: null,
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
      configurableServer: false,
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
    updater: null,
    // There is no machine here to reveal a file on.
    openPath: async () => '',
    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    // Nothing here starts MCP servers, so the set of them never changes.
    onMCPToolsChanged: () => () => {},
  };
}
