/**
 * MCP (Model Context Protocol) server manager for Electron main process.
 *
 * Manages local MCP server processes (stdio/SSE) and provides IPC handlers
 * for the renderer to start/stop servers, list tools, and call tools.
 */

import { ipcMain, dialog, BrowserWindow } from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getSetting, setSetting } from './settings';
import { commandLineFor, describeSpawn, hasConsent, withConsent } from './mcpConsent';

export interface MCPServerConfig {
  name: string;
  transport_type: 'sse' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

interface ManagedServer {
  config: MCPServerConfig;
  client: Client;
  transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;
}

// Active server instances keyed by server name
const servers = new Map<string, ManagedServer>();

const CONSENT_SETTING = 'mcp_stdio_consent';
const PLAYWRIGHT_AUTOSTART_SETTING = 'mcp_playwright_autostart';

function approvedCommandLines(): string[] {
  const stored = getSetting<string[]>(CONSENT_SETTING);
  return Array.isArray(stored) ? stored : [];
}

/**
 * Ask before running a program on the user's machine.
 *
 * A native dialog rather than the in-chat approval bar: this can fire before
 * any renderer is ready (a server starting on connect) and it is not part of a
 * conversation. Anything but an explicit yes — dismissal, no window to attach
 * to — is a refusal.
 */
async function askToSpawn(config: MCPServerConfig): Promise<boolean> {
  const parent = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!parent) {
    console.warn(`[MCP] Refusing to start "${config.name}": no window to ask in`);
    return false;
  }

  const { response } = await dialog.showMessageBox(parent, {
    type: 'warning',
    title: 'Run a local MCP server?',
    message: 'An MCP server wants to run a program on this computer.',
    detail: describeSpawn(config),
    buttons: ['Cancel', 'Allow once', 'Always allow'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });

  if (response === 0) return false;
  if (response === 2) {
    setSetting(CONSENT_SETTING, withConsent(approvedCommandLines(), config));
  }
  return true;
}

/** Command lines the user has approved permanently, for the settings UI. */
export function getApprovedSpawns(): string[] {
  return approvedCommandLines();
}

/** Forget one approved command line. */
export function revokeApprovedSpawn(commandLine: string): string[] {
  const remaining = approvedCommandLines().filter((entry) => entry !== commandLine);
  setSetting(CONSENT_SETTING, remaining);
  return remaining;
}

export function getPlaywrightAutostart(): boolean {
  return getSetting<boolean>(PLAYWRIGHT_AUTOSTART_SETTING) === true;
}

export function setPlaywrightAutostart(enabled: boolean): void {
  setSetting(PLAYWRIGHT_AUTOSTART_SETTING, enabled);
}

export async function startServer(config: MCPServerConfig): Promise<void> {
  // Stop existing server with same name if any
  if (servers.has(config.name)) {
    await stopServer(config.name);
  }

  const client = new Client(
    { name: `kurisu-${config.name}`, version: '1.0.0' },
    { capabilities: {} },
  );

  let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;

  if (config.transport_type === 'stdio' && config.command) {
    // Consent first: this is about to execute `config.command`, which may have
    // been composed by a model or handed over by the backend.
    if (!hasConsent(approvedCommandLines(), config) && !(await askToSpawn(config))) {
      throw new Error(`Refused by user: ${commandLineFor(config)}`);
    }
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: {
        ...process.env,
        ...(config.env || {}),
      } as Record<string, string>,
    });
    await client.connect(transport);
  } else if (config.transport_type === 'sse' && config.url) {
    // Try Streamable HTTP first (modern MCP), fall back to legacy SSE
    const url = new URL(config.url);
    try {
      transport = new StreamableHTTPClientTransport(url);
      await client.connect(transport);
    } catch {
      transport = new SSEClientTransport(url);
      await client.connect(transport);
    }
  } else {
    throw new Error(`Invalid config for server "${config.name}": missing command or url`);
  }

  servers.set(config.name, { config, client, transport });
  console.log(`[MCP] Started server: ${config.name}`);
}

async function stopServer(name: string): Promise<void> {
  const server = servers.get(name);
  if (!server) return;

  try {
    await server.client.close();
  } catch (e) {
    console.error(`[MCP] Error closing server "${name}":`, e);
  }
  servers.delete(name);
  console.log(`[MCP] Stopped server: ${name}`);
}

async function stopAllServers(): Promise<void> {
  const names = [...servers.keys()];
  await Promise.allSettled(names.map((n) => stopServer(n)));
}

interface ToolSchema {
  type: string;
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

async function listAllTools(): Promise<ToolSchema[]> {
  const allTools: ToolSchema[] = [];

  for (const [, server] of servers) {
    try {
      const result = await server.client.listTools();
      for (const tool of result.tools) {
        allTools.push({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.inputSchema as Record<string, unknown>,
          },
        });
      }
    } catch (e) {
      console.error(`[MCP] Error listing tools from "${server.config.name}":`, e);
    }
  }

  return allTools;
}

async function listToolsByServer(): Promise<Record<string, ToolSchema[]>> {
  const grouped: Record<string, ToolSchema[]> = {};

  for (const [name, server] of servers) {
    try {
      const result = await server.client.listTools();
      grouped[name] = result.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.inputSchema as Record<string, unknown>,
        },
      }));
    } catch (e) {
      console.error(`[MCP] Error listing tools from "${name}":`, e);
    }
  }

  return grouped;
}

async function callTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  // Find which server has this tool
  for (const [, server] of servers) {
    try {
      const toolsList = await server.client.listTools();
      const hasTool = toolsList.tools.some((t) => t.name === toolName);
      if (!hasTool) continue;

      const result = await server.client.callTool({ name: toolName, arguments: args });

      // Extract text content from result
      const textParts = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text);

      return {
        content: textParts.join('\n') || JSON.stringify(result.content),
        isError: result.isError === true,
      };
    } catch (e) {
      return {
        content: `Error calling tool "${toolName}": ${e}`,
        isError: true,
      };
    }
  }

  return {
    content: `Tool "${toolName}" not found in any connected server`,
    isError: true,
  };
}

/**
 * Register all MCP-related IPC handlers. Call once from main.ts.
 */
export function registerMCPHandlers(): void {
  ipcMain.handle('mcp:start-servers', async (_event, configs: MCPServerConfig[]) => {
    // Stop all existing first
    await stopAllServers();

    const results: { name: string; ok: boolean; error?: string }[] = [];
    for (const config of configs) {
      try {
        await startServer(config);
        results.push({ name: config.name, ok: true });
      } catch (e) {
        console.error(`[MCP] Failed to start "${config.name}":`, e);
        results.push({ name: config.name, ok: false, error: String(e) });
      }
    }
    return results;
  });

  ipcMain.handle('mcp:start-server', async (_event, config: MCPServerConfig) => {
    try {
      await startServer(config);
      return { name: config.name, ok: true };
    } catch (e) {
      console.error(`[MCP] Failed to start "${config.name}":`, e);
      return { name: config.name, ok: false, error: String(e) };
    }
  });

  ipcMain.handle('mcp:is-server-running', (_event, name: string) => {
    return servers.has(name);
  });

  ipcMain.handle('mcp:get-playwright-autostart', () => getPlaywrightAutostart());

  ipcMain.handle('mcp:set-playwright-autostart', (_event, enabled: boolean) => {
    setPlaywrightAutostart(enabled === true);
    return getPlaywrightAutostart();
  });

  ipcMain.handle('mcp:get-approved-spawns', () => getApprovedSpawns());

  ipcMain.handle('mcp:revoke-approved-spawn', (_event, commandLine: string) =>
    revokeApprovedSpawn(commandLine),
  );

  ipcMain.handle('mcp:stop-servers', async () => {
    await stopAllServers();
  });

  ipcMain.handle('mcp:list-tools', async () => {
    return listAllTools();
  });

  ipcMain.handle('mcp:list-tools-by-server', async () => {
    return listToolsByServer();
  });

  ipcMain.handle(
    'mcp:call-tool',
    async (_event, toolName: string, args: Record<string, unknown>) => {
      return callTool(toolName, args);
    },
  );
}

/**
 * Clean up all servers on app quit.
 */
export async function cleanupMCP(): Promise<void> {
  await stopAllServers();
}
