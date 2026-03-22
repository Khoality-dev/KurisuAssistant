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
import { initAppToolsHandler } from './appToolsHandler';

let initialized = false;
let toolCallHandler: ((event: ToolCallRequestEvent) => void) | null = null;
let clientTools: Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }> = [];

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
      // No client MCP servers — still register host + app tools
      const hostTools = window.electron.hostTools
        ? await window.electron.hostTools.listTools()
        : [];
      const appTools = window.electron.appTools
        ? await window.electron.appTools.listTools()
        : [];
      clientTools = [...hostTools, ...appTools];
      wsManager.sendClientToolsRegister(clientTools);
      setupToolCallHandler();
      initAppToolsHandler();
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
    const mcpTools = await window.electron.mcp.listTools();

    // Merge host tools (file read/write/edit, search, bash)
    const hostTools = window.electron.hostTools
      ? await window.electron.hostTools.listTools()
      : [];

    // Merge app config tools (agent settings, MCP servers, vision)
    const appTools = window.electron.appTools
      ? await window.electron.appTools.listTools()
      : [];

    clientTools = [...hostTools, ...appTools, ...mcpTools];

    // Register all client tools with backend
    wsManager.sendClientToolsRegister(clientTools);

    // Set up handler for incoming tool call requests
    setupToolCallHandler();

    initAppToolsHandler();
    initialized = true;
    console.log(`[MCP] Initialized ${results.filter((r) => r.ok).length} client servers, ${clientTools.length} tools (${hostTools.length} host + ${appTools.length} app + ${mcpTools.length} MCP)`);
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
    try {
      // Check if this is an app config tool (agent settings, MCP servers, vision)
      if (window.electron?.appTools) {
        const isApp = await window.electron.appTools.isAppTool(event.tool_name);
        if (isApp) {
          const result = await window.electron.appTools.callTool(
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
      if (window.electron?.hostTools) {
        const isHost = await window.electron.hostTools.isHostTool(event.tool_name);
        if (isHost) {
          const agentId = (event.tool_args as Record<string, unknown>).agent_id as number || 0;
          const result = await window.electron.hostTools.callTool(
            event.tool_name,
            event.tool_args,
            agentId,
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
      if (!window.electron?.mcp) {
        wsManager.sendToolCallResponse(
          event.request_id,
          'Electron MCP not available',
          true,
        );
        return;
      }

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
  if (!window.electron?.mcp) return {};
  return window.electron.mcp.listToolsByServer();
}

// Auto-initialize on WebSocket connect
wsManager.on('connected', () => {
  initClientMCPServers();
});
