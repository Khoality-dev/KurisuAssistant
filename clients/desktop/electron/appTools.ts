/**
 * App config tools — let agents manage settings, MCP servers, and vision.
 *
 * These tools need renderer-side APIs (apiClient, Zustand stores), so the main
 * process forwards calls to the renderer via IPC and waits for the result.
 */

import { ipcMain, BrowserWindow } from 'electron';

// --- Tool schemas ---

interface ToolSchema {
  type: string;
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const APP_TOOL_NAMES = new Set([
  'app_get_agents',
  'app_update_agent',
  'app_list_mcp_servers',
  'app_add_mcp_server',
  'app_update_mcp_server',
  'app_delete_mcp_server',
  'app_vision_start',
  'app_vision_stop',
]);

function getAppToolSchemas(): ToolSchema[] {
  return [
    // --- Agent settings ---
    {
      type: 'function',
      function: {
        name: 'app_get_agents',
        description: 'List all agents configured in the app with their settings.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'app_update_agent',
        description:
          'Update an agent\'s settings. Only provide fields you want to change.',
        parameters: {
          type: 'object',
          properties: {
            agent_id: { type: 'integer', description: 'ID of the agent to update.' },
            name: { type: 'string', description: 'New display name.' },
            system_prompt: { type: 'string', description: 'New system prompt / personality.' },
            model_name: { type: 'string', description: 'LLM model name (e.g. "gemma3:4b").' },
            excluded_tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of tool names to exclude.',
            },
            think: { type: 'boolean', description: 'Enable extended reasoning.' },
            memory_enabled: { type: 'boolean', description: 'Enable memory injection + consolidation.' },
            preferred_name: { type: 'string', description: 'How the user wants to be called.' },
            trigger_word: { type: 'string', description: 'Voice activation trigger word.' },
          },
          required: ['agent_id'],
        },
      },
    },
    // --- MCP servers ---
    {
      type: 'function',
      function: {
        name: 'app_list_mcp_servers',
        description: 'List all configured MCP servers with their status.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'app_add_mcp_server',
        description: 'Add a new MCP server. Use transport_type "sse" with url, or "stdio" with command.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Server display name.' },
            transport_type: { type: 'string', enum: ['sse', 'stdio'], description: 'Transport type.' },
            url: { type: 'string', description: 'Server URL (for SSE transport).' },
            command: { type: 'string', description: 'Command to run (for stdio transport).' },
            args: { type: 'array', items: { type: 'string' }, description: 'Command arguments (for stdio).' },
            env: { type: 'object', description: 'Environment variables as key-value pairs.' },
            location: { type: 'string', enum: ['server', 'client'], description: 'Where the server runs (default: "server").' },
          },
          required: ['name', 'transport_type'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'app_update_mcp_server',
        description: 'Update an existing MCP server. Only provide fields to change.',
        parameters: {
          type: 'object',
          properties: {
            server_id: { type: 'integer', description: 'ID of the MCP server to update.' },
            name: { type: 'string', description: 'New display name.' },
            transport_type: { type: 'string', enum: ['sse', 'stdio'], description: 'Transport type.' },
            url: { type: 'string', description: 'Server URL.' },
            command: { type: 'string', description: 'Command to run.' },
            args: { type: 'array', items: { type: 'string' }, description: 'Command arguments.' },
            env: { type: 'object', description: 'Environment variables.' },
            enabled: { type: 'boolean', description: 'Enable or disable the server.' },
            location: { type: 'string', enum: ['server', 'client'], description: 'Where the server runs.' },
          },
          required: ['server_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'app_delete_mcp_server',
        description: 'Delete an MCP server by ID.',
        parameters: {
          type: 'object',
          properties: {
            server_id: { type: 'integer', description: 'ID of the MCP server to delete.' },
          },
          required: ['server_id'],
        },
      },
    },
    // --- Vision ---
    {
      type: 'function',
      function: {
        name: 'app_vision_start',
        description: 'Start the camera/vision pipeline for face recognition and gesture detection.',
        parameters: {
          type: 'object',
          properties: {
            enable_face: { type: 'boolean', description: 'Enable face recognition (default: true).' },
            enable_pose: { type: 'boolean', description: 'Enable pose detection (default: false).' },
            enable_hands: { type: 'boolean', description: 'Enable hand detection (default: false).' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'app_vision_stop',
        description: 'Stop the camera/vision pipeline.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    },
  ];
}

// --- IPC: forward tool calls to renderer ---

// Pending calls waiting for renderer response
let callCounter = 0;
const pendingCalls = new Map<number, { resolve: (result: any) => void; timer: ReturnType<typeof setTimeout> }>();

export function registerAppToolIPC(): void {
  ipcMain.handle('app-tools:list-tools', () => {
    return getAppToolSchemas();
  });

  ipcMain.handle('app-tools:is-app-tool', (_event, name: string) => {
    return APP_TOOL_NAMES.has(name);
  });

  ipcMain.handle(
    'app-tools:call-tool',
    async (_event, name: string, args: Record<string, unknown>) => {
      const mainWindow = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
      if (!mainWindow) {
        return { content: JSON.stringify({ error: 'No window available.' }), isError: true };
      }

      const callId = ++callCounter;

      return new Promise<{ content: string; isError: boolean }>((resolve) => {
        const timer = setTimeout(() => {
          pendingCalls.delete(callId);
          resolve({ content: JSON.stringify({ error: 'App tool execution timed out.' }), isError: true });
        }, 30000);

        pendingCalls.set(callId, { resolve, timer });

        // Send to renderer for execution
        mainWindow.webContents.send('app-tools:execute', { callId, name, args });
      });
    },
  );

  // Renderer sends result back
  ipcMain.on('app-tools:result', (_event, callId: number, result: { content: string; isError: boolean }) => {
    const pending = pendingCalls.get(callId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingCalls.delete(callId);
      pending.resolve(result);
    }
  });
}

export { APP_TOOL_NAMES, getAppToolSchemas };
