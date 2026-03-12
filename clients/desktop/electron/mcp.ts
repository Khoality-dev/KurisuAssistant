/**
 * MCP (Model Context Protocol) server manager for Electron main process.
 *
 * Manages local MCP server processes (stdio/SSE) and provides IPC handlers
 * for the renderer to start/stop servers, list tools, and call tools.
 */

import { ipcMain } from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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

async function startServer(config: MCPServerConfig): Promise<void> {
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
