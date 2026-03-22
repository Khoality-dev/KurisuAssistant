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
  if (!window.electron) {
    // Not running in Electron — skip
    return;
  }

  // Always collect built-in tools (host, app) regardless of MCP state
  const hostTools = window.electron.hostTools
    ? await window.electron.hostTools.listTools().catch(() => [])
    : [];
  const appTools = window.electron.appTools
    ? await window.electron.appTools.listTools().catch(() => [])
    : [];
  const builtinTools = [...hostTools, ...appTools];

  console.log(`[MCP] Built-in tools: ${hostTools.length} host + ${appTools.length} app`);

  // Auto-start Playwright MCP server (stdio, always available for browser tools)
  if (window.electron?.mcp?.startServer) {
    try {
      const result = await window.electron.mcp.startServer(
        { name: 'Playwright', transport_type: 'stdio', command: 'npx', args: ['@playwright/mcp'] },
      );
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
    // Fetch all MCP server configs
    const servers = await apiClient.listMCPServers();

    // Filter to client-side servers only
    const clientServers = servers.filter(
      (s) => s.location === 'client' && s.enabled,
    );

    // Start client-side MCP servers one by one (don't use startServers which kills all)
    for (const s of clientServers) {
      try {
        await window.electron.mcp.startServer({
          name: s.name,
          transport_type: s.transport_type,
          url: s.url || undefined,
          command: s.command || undefined,
          args: s.args || undefined,
          env: s.env || undefined,
        });
      } catch (e) {
        console.warn(`[MCP] Failed to start "${s.name}":`, e);
      }
    }

    // Discover tools from ALL connected MCP servers (includes Playwright + client servers)
    const mcpTools = window.electron.mcp
      ? await window.electron.mcp.listTools()
      : [];

    clientTools = [...builtinTools, ...mcpTools];

    // Register all client tools with backend
    wsManager.sendClientToolsRegister(clientTools);

    // Set up handler for incoming tool call requests
    setupToolCallHandler();

    initAppToolsHandler();
    initialized = true;
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
      console.log(`[MCP] Registered ${builtinTools.length} built-in tools (MCP failed)`);
    }
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

// Re-register tools when MCP servers change (e.g. Playwright started by app_launch_browser)
if (window.electron?.onMCPToolsChanged) {
  window.electron.onMCPToolsChanged(() => {
    console.log('[MCP] Tools changed — re-registering');
    refreshClientMCPServers();
  });
}
