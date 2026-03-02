/**
 * Client-side MCP service — lifecycle management for internal MCP servers.
 *
 * On WebSocket connect:
 * 1. Fetches MCP server configs from API, filters location="client"
 * 2. Starts local MCP server processes via Electron IPC
 * 3. Discovers tools from local servers
 * 4. Registers tool schemas with backend via WebSocket
 *
 * On tool_call_request from backend:
 * 1. Calls tool via Electron IPC
 * 2. Sends result back via WebSocket
 */

import { apiClient } from '../api/client';
import { wsManager, type ToolCallRequestEvent } from '../api/websocket';

let initialized = false;
let toolCallHandler: ((event: ToolCallRequestEvent) => void) | null = null;

/**
 * Initialize client-side MCP servers and register tools with backend.
 * Called after WebSocket connect (ConnectedEvent).
 */
export async function initClientMCPServers(): Promise<void> {
  if (!window.electron?.mcp) {
    // Not running in Electron — skip
    return;
  }

  try {
    // Fetch all MCP server configs
    const servers = await apiClient.listMCPServers();

    // Filter to client-side servers only
    const clientServers = servers.filter(
      (s) => s.location === 'client' && s.enabled,
    );

    if (clientServers.length === 0) {
      // No client servers — send empty registration to clear any stale tools
      wsManager.sendClientToolsRegister([]);
      setupToolCallHandler();
      initialized = true;
      return;
    }

    // Start local MCP servers via Electron IPC
    const configs = clientServers.map((s) => ({
      name: s.name,
      transport_type: s.transport_type,
      url: s.url || undefined,
      command: s.command || undefined,
      args: s.args || undefined,
      env: s.env || undefined,
    }));

    const results = await window.electron.mcp.startServers(configs);
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      console.warn(
        '[MCP] Some servers failed to start:',
        failed.map((f) => `${f.name}: ${f.error}`).join(', '),
      );
    }

    // Discover tools from all connected servers
    const tools = await window.electron.mcp.listTools();

    // Register tools with backend
    wsManager.sendClientToolsRegister(tools);

    // Set up handler for incoming tool call requests
    setupToolCallHandler();

    initialized = true;
    console.log(`[MCP] Initialized ${results.filter((r) => r.ok).length} client servers, ${tools.length} tools`);
  } catch (e) {
    console.error('[MCP] Failed to initialize client MCP servers:', e);
  }
}

/**
 * Stop all client-side MCP servers.
 */
export async function stopClientMCPServers(): Promise<void> {
  if (!window.electron?.mcp) return;

  // Remove tool call handler
  if (toolCallHandler) {
    wsManager.off('tool_call_request', toolCallHandler);
    toolCallHandler = null;
  }

  try {
    await window.electron.mcp.stopServers();
  } catch (e) {
    console.error('[MCP] Failed to stop client MCP servers:', e);
  }

  initialized = false;
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
    if (!window.electron?.mcp) {
      wsManager.sendToolCallResponse(
        event.request_id,
        'Electron MCP not available',
        true,
      );
      return;
    }

    try {
      const result = await window.electron.mcp.callTool(
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

// Auto-initialize on WebSocket connect
wsManager.on('connected', () => {
  initClientMCPServers();
});
