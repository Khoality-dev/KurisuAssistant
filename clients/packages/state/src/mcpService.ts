/**
 * Client-side MCP service — lifecycle management for internal MCP servers.
 *
 * On WebSocket connect:
 * 1. Collects the built-in host and app tool schemas
 * 2. Starts Playwright, if the user turned its auto-start on
 * 3. Discovers tools from every locally running MCP server
 * 4. Registers the lot with the backend via WebSocket
 *
 * It does not fetch `location: "client"` server configs from the backend and
 * spawn them, whatever this comment used to say. Any spawn goes through
 * `electron/mcp.ts`, which asks the user first.
 *
 * On tool_call_request from backend:
 * 1. Calls tool via Electron IPC
 * 2. Sends result back via WebSocket
 */

import { wsManager, type ToolCallRequestEvent } from '@kurisu/api';
import { initAppToolsHandler } from './appToolsHandler';
import { PLAYWRIGHT_MCP_ARGS } from '@kurisu/models';
import { resolveBridge } from '@kurisu/platform';

let initialized = false;
let initializing = false;
let toolCallHandler: ((event: ToolCallRequestEvent) => void) | null = null;
let clientTools: Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }> = [];

/**
 * Initialize client-side MCP servers and register tools with backend.
 * Called after WebSocket connect (ConnectedEvent).
 */
export async function initClientMCPServers(): Promise<void> {
  // Nothing to register when the host lends no tools of its own: a browser has
  // no shell, no child processes and no apps to drive, so the backend's own
  // tools are the whole set.
  const bridge = resolveBridge();
  const { capabilities } = bridge;
  if (!capabilities.hostTools && !capabilities.stdioMcp && !capabilities.hostApps) {
    return;
  }

  // Prevent concurrent initialization (rapid reconnects, StrictMode double-mount)
  if (initializing) {
    console.log('[MCP] Already initializing, skipping duplicate call');
    return;
  }
  initializing = true;

  // Always collect built-in tools (host, app) regardless of MCP state
  const hostTools = bridge.hostTools
    ? await bridge.hostTools.listTools().catch(() => [])
    : [];
  const appTools = bridge.appTools
    ? await bridge.appTools.listTools().catch(() => [])
    : [];
  const builtinTools = [...hostTools, ...appTools];

  console.log(`[MCP] Built-in tools: ${hostTools.length} host + ${appTools.length} app`);

  // Playwright, only if the user asked for it to start on its own.
  //
  // This used to run on every connect: an unpinned `npx @playwright/mcp`,
  // fetching and executing whatever the registry served that day, with no
  // consent and no version. It is opt-in now (Settings → Tools & MCP), pinned,
  // and — like any stdio server — subject to the spawn prompt in the main
  // process the first time that command line runs.
  const mcp = bridge.mcp;
  if (mcp?.startServer && (await mcp.getPlaywrightAutostart())) {
    try {
      const result = await mcp.startServer({
        name: 'Playwright',
        transport_type: 'stdio',
        command: 'npx',
        args: [...PLAYWRIGHT_MCP_ARGS],
      });
      if (result.ok) {
        console.log('[MCP] Playwright MCP server started');
      } else {
        console.warn('[MCP] Playwright MCP server failed:', result.error);
      }
    } catch (e) {
      console.warn('[MCP] Failed to start Playwright MCP server:', e);
    }
  }

  try {
    // Discover tools from all locally running MCP servers (Playwright + any started by settings UI)
    const mcpTools = mcp ? await mcp.listTools() : [];

    clientTools = [...builtinTools, ...mcpTools];

    // Register all client tools with backend
    wsManager.sendClientToolsRegister(clientTools);

    // Set up handler for incoming tool call requests
    setupToolCallHandler();

    initAppToolsHandler();
    initialized = true;
    initializing = false;
    console.log(`[MCP] Initialized ${clientTools.length} tools (${builtinTools.length} built-in + ${mcpTools.length} MCP)`);
  } catch (e) {
    console.error('[MCP] Failed to initialize client MCP servers:', e);
    // Still register built-in tools even if MCP init fails
    if (builtinTools.length > 0 && !initialized) {
      clientTools = builtinTools;
      wsManager.sendClientToolsRegister(clientTools);
      setupToolCallHandler();
      initAppToolsHandler();
      initialized = true;
    }
    initializing = false;
  }
}

/**
 * Stop all client-side MCP servers.
 */
export async function stopClientMCPServers(): Promise<void> {
  // Remove tool call handler
  if (toolCallHandler) {
    wsManager.off('tool_call_request', toolCallHandler);
    toolCallHandler = null;
  }

  // Don't call stopServers() — it kills all servers including Playwright.
  // initClientMCPServers uses startServer (singular) which replaces by name.

  initialized = false;
  initializing = false;
}

/**
 * Restart client-side MCP servers (e.g., after config changes).
 */
export async function refreshClientMCPServers(): Promise<void> {
  await stopClientMCPServers();
  await initClientMCPServers();
}

/**
 * Set up handler for tool_call_request events from backend.
 */
function setupToolCallHandler(): void {
  // Remove existing handler if any
  if (toolCallHandler) {
    wsManager.off('tool_call_request', toolCallHandler);
  }

  toolCallHandler = async (event: ToolCallRequestEvent) => {
    const bridge = resolveBridge();
    try {
      // Check if this is an app config tool (agent settings, MCP servers, vision)
      if (bridge.appTools) {
        const isApp = await bridge.appTools.isAppTool(event.tool_name);
        if (isApp) {
          const result = await bridge.appTools.callTool(
            event.tool_name,
            event.tool_args,
          );
          wsManager.sendToolCallResponse(
            event.request_id,
            result.content,
            result.isError,
          );
          return;
        }
      }

      // Check if this is a host tool (file read/write/edit, search, bash)
      if (bridge.hostTools) {
        const isHost = await bridge.hostTools.isHostTool(event.tool_name);
        if (isHost) {
          const result = await bridge.hostTools.callTool(
            event.tool_name,
            event.tool_args,
          );
          wsManager.sendToolCallResponse(
            event.request_id,
            result.content,
            result.isError,
          );
          return;
        }
      }

      // Fall through to MCP tools
      if (!bridge.mcp) {
        wsManager.sendToolCallResponse(
          event.request_id,
          'Electron MCP not available',
          true,
        );
        return;
      }

      const result = await bridge.mcp.callTool(
        event.tool_name,
        event.tool_args,
      );
      wsManager.sendToolCallResponse(
        event.request_id,
        result.content,
        result.isError,
      );
    } catch (e) {
      wsManager.sendToolCallResponse(
        event.request_id,
        `Client tool execution error: ${e}`,
        true,
      );
    }
  };

  wsManager.on('tool_call_request', toolCallHandler);
}

/**
 * Whether client MCP servers have been initialized.
 */
export function isInitialized(): boolean {
  return initialized;
}

/**
 * Get the list of client-side tools discovered during initialization.
 */
export function getClientTools() {
  return clientTools;
}

/**
 * Get client-side tools grouped by server name.
 */
export async function getClientToolsByServer(): Promise<Record<string, typeof clientTools>> {
  const mcp = resolveBridge().mcp;
  if (!mcp) return {};
  return mcp.listToolsByServer();
}

// Auto-initialize on WebSocket connect
wsManager.on('connected', () => {
  initClientMCPServers();
});

// Re-register tools when MCP servers change (e.g. Playwright started by app_launch_browser)
resolveBridge().onMCPToolsChanged(() => {
  console.log('[MCP] Tools changed — re-registering');
  refreshClientMCPServers();
});
