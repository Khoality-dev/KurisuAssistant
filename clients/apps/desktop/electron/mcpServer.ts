/**
 * MCP server exposing all built-in tools (host + app) to external MCP clients.
 *
 * Runs an SSE server so tools like Claude Code can connect. Every tool it
 * publishes runs on this machine, `host_bash` among them, so the endpoint is
 * treated as a privileged one:
 *
 * - it listens on 127.0.0.1 only, never on a routable interface;
 * - it sends no CORS headers and refuses anything carrying browser headers, so
 *   a page the user is visiting cannot complete the SSE handshake;
 * - every path but `/health` needs the bearer token minted on first run and
 *   kept in the main process's settings file.
 *
 * The token is shown in Settings → Tools & MCP; an external client sends it as
 * `Authorization: Bearer <token>`.
 */

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { ipcMain } from 'electron';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { getHostToolSchemas, executeHostTool, HOST_TOOL_NAMES } from './hostTools';
import { getAppToolSchemas, executeAppTool, APP_TOOL_NAMES } from './appTools';
import { authorizeMcpRequest } from './mcpServerAuth';
import { getSetting, setSetting } from './settings';

const DEFAULT_PORT = 15599;
const HOST = '127.0.0.1';
const TOKEN_SETTING = 'mcp_server_token';

let httpServer: http.Server | null = null;
let activePort = DEFAULT_PORT;

interface ToolSchema {
  type: string;
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * The bearer token for this installation, minted once and persisted.
 * Regenerating it on every launch would invalidate the external client's
 * configuration on every restart.
 */
export function getMcpServerToken(): string {
  const existing = getSetting<string>(TOKEN_SETTING);
  if (typeof existing === 'string' && existing.length >= 32) return existing;
  const minted = randomBytes(32).toString('hex');
  setSetting(TOKEN_SETTING, minted);
  return minted;
}

/** Mint a fresh token, invalidating whatever the old one authorised. */
export function rotateMcpServerToken(): string {
  const minted = randomBytes(32).toString('hex');
  setSetting(TOKEN_SETTING, minted);
  return minted;
}

export function getMcpServerInfo(): { url: string; token: string; running: boolean } {
  return {
    url: `http://${HOST}:${activePort}/sse`,
    token: getMcpServerToken(),
    running: httpServer !== null,
  };
}

function convertToMcpResult(result: { content: string; isError: boolean }) {
  return {
    content: [{ type: 'text' as const, text: result.content }],
    isError: result.isError,
  };
}

function deny(res: http.ServerResponse, status: number, error: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error }));
}

export function startMcpServer(port: number | undefined = DEFAULT_PORT): void {
  port = port ?? DEFAULT_PORT;
  if (httpServer) {
    console.log('[MCP Server] Already running');
    return;
  }

  activePort = port;

  // Collect all tool schemas
  const allSchemas: ToolSchema[] = [
    ...getHostToolSchemas(),
    ...getAppToolSchemas(),
  ];

  // Track active transports per session
  const transports = new Map<string, SSEServerTransport>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${HOST}:${port}`);

    // No CORS headers are sent at all: this endpoint has no browser clients,
    // and the wildcard it used to send was what let any visited page open a
    // session and call host_bash.
    const decision = authorizeMcpRequest(req, url.pathname, getMcpServerToken());
    if (!decision.ok) {
      console.warn(`[MCP Server] Refused ${req.method} ${url.pathname}: ${decision.reason}`);
      deny(res, decision.status, decision.error);
      return;
    }

    if (url.pathname === '/sse' && req.method === 'GET') {
      // New SSE connection — create a fresh MCP server + transport per session
      const mcpServer = new McpServer(
        { name: 'KurisuAssistant', version: '1.0.0' },
        { capabilities: { tools: {} } },
      );

      // Register all tools
      for (const schema of allSchemas) {
        const toolName = schema.function.name;
        mcpServer.tool(
          toolName,
          schema.function.description,
          // No zod schema — accept raw args
          async (args: Record<string, unknown>) => {
            let result: { content: string; isError: boolean };
            if (HOST_TOOL_NAMES.has(toolName)) {
              result = await executeHostTool(toolName, args);
            } else if (APP_TOOL_NAMES.has(toolName)) {
              result = await executeAppTool(toolName, args);
            } else {
              result = { content: `Unknown tool: ${toolName}`, isError: true };
            }
            return convertToMcpResult(result);
          },
        );
      }

      const transport = new SSEServerTransport('/messages', res);
      transports.set(transport.sessionId, transport);

      transport.onclose = () => {
        transports.delete(transport.sessionId);
      };

      await mcpServer.connect(transport);
      return;
    }

    if (url.pathname === '/messages' && req.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId');
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        deny(res, 400, 'Invalid or missing sessionId');
        return;
      }
      await transport.handlePostMessage(req, res);
      return;
    }

    // Health check. Reachable without a token so a client can tell "not
    // running" from "wrong token", and says nothing a caller could use.
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', name: 'KurisuAssistant' }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  // A listen failure used to reach an unhandled 'error' event, which takes the
  // whole main process down over a port clash with a second install.
  server.on('error', (err) => {
    console.error('[MCP Server] Failed to listen:', err);
    if (httpServer === server) httpServer = null;
  });

  httpServer = server;
  server.listen(port, HOST, () => {
    console.log(`[MCP Server] Listening on http://${HOST}:${port}/sse (${allSchemas.length} tools, token required)`);
  });
}

export function stopMcpServer(): void {
  if (httpServer) {
    httpServer.close();
    httpServer = null;
    console.log('[MCP Server] Stopped');
  }
}

export function isMcpServerRunning(): boolean {
  return httpServer !== null;
}

/**
 * IPC for the settings UI: the endpoint and its token have to be readable
 * somewhere, or an external client cannot be configured at all.
 */
export function registerMcpServerIPC(): void {
  ipcMain.handle('mcp-server:get-info', () => getMcpServerInfo());
  ipcMain.handle('mcp-server:rotate-token', () => {
    rotateMcpServerToken();
    return getMcpServerInfo();
  });
}
