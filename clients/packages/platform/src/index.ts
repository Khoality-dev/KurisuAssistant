/**
 * One interface for whatever is hosting the renderer.
 *
 * The renderer used to reach for `window.electron` wherever it needed the
 * machine underneath it — around 130 times, in forty different spellings of the
 * same guard. That works while there is exactly one host. There is about to be a
 * second (#128), and a browser tab can answer almost none of it, so the question
 * "can I do this here?" needs one place to be asked and one place to be answered.
 */
import { electronBridge } from './electron';
import type {
  AppToolsAPI,
  CharacterWindowAPI,
  CredentialsAPI,
  DriveTransferAPI,
  ExplorerAPI,
  ExtensionsAPI,
  HostToolsAPI,
  MCPAPI,
  McpServerAPI,
} from './types';
import { webBridge } from './web';

export * from './types';

/**
 * What this host can actually do.
 *
 * Every flag is named after the capability, never after the host: ask
 * `capabilities.localFiles`, not `platform === 'web'`. The first reads as the
 * reason the code is doing what it does, and stays correct when a third host
 * turns up; the second is a guess about every host that is not this one, and it
 * is the guess that has to be revisited every time.
 */
export interface Capabilities {
  /** A filesystem belonging to the machine the renderer is displayed on. */
  localFiles: boolean;
  /** Tools the assistant runs against that machine, behind an approval. */
  hostTools: boolean;
  /** MCP servers started here as child processes over stdio. */
  stdioMcp: boolean;
  /** Launching another application installed on this machine. */
  hostApps: boolean;
  /** Downloading and installing one. */
  installer: boolean;
  /** The app can replace itself. */
  autoUpdate: boolean;
  /** Tokens survive a restart in something better than plain text. */
  secureCredentials: boolean;
  /** This app is itself an MCP endpoint an external client can connect to. */
  mcpEndpoint: boolean;
  /** The character can be given a window of its own. */
  characterWindow: boolean;
  /** A file transfer reports progress and can be cancelled. */
  transferProgress: boolean;
  /**
   * The backend address is the user's to choose.
   *
   * An installed app has to be told where its server is. A build served *by*
   * that server already knows, and pointing it anywhere else would make every
   * call cross-origin — so for it this is false and the field is not shown.
   */
  configurableServer: boolean;
}

/**
 * Anything the renderer cannot do on its own.
 *
 * A `null` member is not an error state — it is this host saying it does not
 * offer that, and the matching `capabilities` flag is what the UI should ask
 * before it renders a control for it.
 */
export interface PlatformBridge {
  readonly platform: 'electron' | 'web';
  readonly capabilities: Capabilities;
  /** The OS underneath, where the host knows it. `null` in a browser. */
  readonly os: string | null;
  readonly files: ExplorerAPI | null;
  readonly transfers: DriveTransferAPI | null;
  readonly credentials: CredentialsAPI | null;
  readonly characterWindow: CharacterWindowAPI | null;
  readonly hostTools: HostToolsAPI | null;
  readonly mcp: MCPAPI | null;
  readonly mcpServer: McpServerAPI | null;
  readonly appTools: AppToolsAPI | null;
  readonly extensions: ExtensionsAPI | null;
  /** Hand a path or URL to whatever the host opens it with. */
  openPath(target: string): Promise<string>;
  onMCPToolsChanged(cb: () => void): () => void;
}

let resolved: PlatformBridge | null = null;

/** The bridge for the host this renderer is running in, resolved once. */
export function resolveBridge(): PlatformBridge {
  if (!resolved) {
    resolved = electronBridge() ?? webBridge();
  }
  return resolved;
}

/**
 * Install a bridge, or clear it so the next `resolveBridge()` detects again.
 *
 * For tests. Production code never calls this — the host is not a choice.
 */
export function setBridge(bridge: PlatformBridge | null): void {
  resolved = bridge;
}
