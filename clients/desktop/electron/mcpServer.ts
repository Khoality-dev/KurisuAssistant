/**
 * MCP server exposing all built-in tools (host + app) to external MCP clients.
 *
 * Runs an SSE server on a configurable port so tools like Claude Code can connect.
 */

import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { getHostToolSchemas, executeHostTool, HOST_TOOL_NAMES } from './hostTools';
import { getAppToolSchemas, executeAppTool, APP_TOOL_NAMES } from './appTools';

const DEFAULT_PORT = 15599;
let httpServer: http.Server | null = null;

interface ToolSchema {
  type: string;
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

function convertToMcpResult(result: { content: string; isError: boolean }) {
  return {
    content: [{ type: 'text' as const, text: result.content }],
    isError: result.isError,
  };
}

export function startMcpServer(port: number = DEFAULT_PORT): void {
  if (httpServer) {
    console.log('[MCP Server] Already running');
    return;
  }

  // Collect all tool schemas
  const allSchemas: ToolSchema[] = [
    ...getHostToolSchemas(),
    ...getAppToolSchemas(),
  ];

  // Track active transports per session
  const transports = new Map<string, SSEServerTransport>();

  httpServer = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://localhost:${port}`);

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
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing sessionId' }));
        return;
      }
      await transport.handlePostMessage(req, res);
      return;
    }

    // Health check
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', tools: allSchemas.length }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  httpServer.listen(port, () => {
    console.log(`[MCP Server] Listening on http://localhost:${port}/sse (${allSchemas.length} tools)`);
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
