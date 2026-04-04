/**
 * App config tools — let agents manage settings, MCP servers, and vision.
 *
 * These tools need renderer-side APIs (apiClient, Zustand stores), so the main
 * process forwards calls to the renderer via IPC and waits for the result.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { startServer } from './mcp';

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
  'app_create_agent',
  'app_update_agent',
  'app_delete_agent',
  'app_get_personas',
  'app_create_persona',
  'app_update_persona',
  'app_delete_persona',
  'app_list_mcp_servers',
  'app_add_mcp_server',
  'app_update_mcp_server',
  'app_delete_mcp_server',
  'app_list_skills',
  'app_create_skill',
  'app_update_skill',
  'app_delete_skill',
  'app_list_tools',
  'app_vision_start',
  'app_vision_stop',
  'app_end_interaction',
  'app_launch_browser',
  'app_open_file',
  'app_open_folder',
  'app_get_open_files',
  'app_navigate',
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
        name: 'app_create_agent',
        description: 'Create a new agent with a name, system prompt, and model. Optionally link a persona.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Display name for the new agent.' },
            system_prompt: { type: 'string', description: 'System prompt / personality.' },
            model_name: { type: 'string', description: 'LLM model name (e.g. "gemma3:4b").' },
            provider_type: { type: 'string', enum: ['ollama', 'gemini'], description: 'LLM provider (default: "ollama").' },
            think: { type: 'boolean', description: 'Enable extended reasoning.' },
            persona_id: { type: 'integer', description: 'ID of a persona to link (provides voice, avatar, trigger word, preferred name).' },
          },
          required: ['name', 'model_name'],
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
            available_tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Allowlist of tool names (null = all tools available).',
            },
            think: { type: 'boolean', description: 'Enable extended reasoning.' },
            memory_enabled: { type: 'boolean', description: 'Enable memory injection + consolidation.' },
            persona_id: { type: 'integer', description: 'ID of a persona to link (provides voice, avatar, trigger word, preferred name). Use 0 or null to unlink.' },
          },
          required: ['agent_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'app_delete_agent',
        description: 'Delete an agent by ID.',
        parameters: {
          type: 'object',
          properties: {
            agent_id: { type: 'integer', description: 'ID of the agent to delete.' },
          },
          required: ['agent_id'],
        },
      },
    },
    // --- Personas ---
    {
      type: 'function',
      function: {
        name: 'app_get_personas',
        description: 'List all personas. Personas hold identity fields (voice, avatar, trigger word, preferred name, character config) that can be shared across agents.',
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
        name: 'app_create_persona',
        description: 'Create a new persona with identity fields.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Display name for the persona.' },
            system_prompt: { type: 'string', description: 'System prompt / personality.' },
            preferred_name: { type: 'string', description: 'How agents with this persona should address the user.' },
            trigger_word: { type: 'string', description: 'Voice activation trigger word.' },
          },
          required: ['name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'app_update_persona',
        description: 'Update a persona. Only provide fields you want to change.',
        parameters: {
          type: 'object',
          properties: {
            persona_id: { type: 'integer', description: 'ID of the persona to update.' },
            name: { type: 'string', description: 'New display name.' },
            system_prompt: { type: 'string', description: 'New system prompt / personality.' },
            preferred_name: { type: 'string', description: 'How the user wants to be called.' },
            trigger_word: { type: 'string', description: 'Voice activation trigger word.' },
          },
          required: ['persona_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'app_delete_persona',
        description: 'Delete a persona by ID. Agents linked to it will have their persona_id cleared.',
        parameters: {
          type: 'object',
          properties: {
            persona_id: { type: 'integer', description: 'ID of the persona to delete.' },
          },
          required: ['persona_id'],
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
    // --- Skills ---
    {
      type: 'function',
      function: {
        name: 'app_list_skills',
        description: 'List all skills configured for the current user.',
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
        name: 'app_create_skill',
        description: 'Create a new skill with a name and instructions.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Skill name.' },
            instructions: { type: 'string', description: 'Skill instructions / content.' },
          },
          required: ['name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'app_update_skill',
        description: 'Update a skill. Only provide fields you want to change.',
        parameters: {
          type: 'object',
          properties: {
            skill_id: { type: 'integer', description: 'ID of the skill to update.' },
            name: { type: 'string', description: 'New skill name.' },
            instructions: { type: 'string', description: 'New instructions.' },
          },
          required: ['skill_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'app_delete_skill',
        description: 'Delete a skill by ID.',
        parameters: {
          type: 'object',
          properties: {
            skill_id: { type: 'integer', description: 'ID of the skill to delete.' },
          },
          required: ['skill_id'],
        },
      },
    },
    // --- Tools ---
    {
      type: 'function',
      function: {
        name: 'app_list_tools',
        description: 'List all available tools (built-in and MCP) with their schemas.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
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
    // --- Voice interaction ---
    {
      type: 'function',
      function: {
        name: 'app_end_interaction',
        description: 'End the current voice interaction session. Call this when the user indicates they are done — e.g. "that\'s all", "nothing else", "bye", "I\'ll call you later", "talk to you later", or similar farewell/dismissal phrases.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    },
    // --- Browser ---
    {
      type: 'function',
      function: {
        name: 'app_launch_browser',
        description:
          'Launch the user\'s browser with remote debugging enabled so Playwright MCP can connect to it. ' +
          'Returns the CDP endpoint URL. Use with @playwright/mcp --cdp-endpoint.',
        parameters: {
          type: 'object',
          properties: {
            browser: {
              type: 'string',
              enum: ['chrome', 'edge', 'auto'],
              description: 'Which browser to launch (default: "auto" — detects installed browser).',
            },
            port: {
              type: 'integer',
              description: 'Remote debugging port (default: 9222).',
            },
            url: {
              type: 'string',
              description: 'URL to open on launch.',
            },
          },
          required: [],
        },
      },
    },
    // --- UI control ---
    {
      type: 'function',
      function: {
        name: 'app_open_file',
        description: 'Open a file in the editor. The file will appear as a tab in the workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the file to open.' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'app_open_folder',
        description: 'Navigate the file explorer to a folder.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the folder.' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'app_get_open_files',
        description: 'List all files currently open in the editor.',
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
        name: 'app_navigate',
        description: 'Switch the app to a different page.',
        parameters: {
          type: 'object',
          properties: {
            page: {
              type: 'string',
              enum: ['workspace', 'conversations', 'settings'],
              description: 'The page to navigate to.',
            },
          },
          required: ['page'],
        },
      },
    },
  ];
}

// --- Browser launch (runs in main process, not renderer) ---

function findBrowser(preference: string): { name: string; path: string } | null {
  const candidates: { name: string; paths: string[] }[] = [
    {
      name: 'chrome',
      paths: process.platform === 'win32'
        ? [
            path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    },
    {
      name: 'edge',
      paths: process.platform === 'win32'
        ? [
            path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          ]
        : ['/usr/bin/microsoft-edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    },
  ];

  if (preference !== 'auto') {
    const match = candidates.find(c => c.name === preference);
    if (match) {
      const found = match.paths.find(p => fs.existsSync(p));
      if (found) return { name: match.name, path: found };
    }
    return null;
  }

  // Auto-detect: try each in order
  for (const candidate of candidates) {
    const found = candidate.paths.find(p => fs.existsSync(p));
    if (found) return { name: candidate.name, path: found };
  }
  return null;
}

async function executeLaunchBrowser(args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
  const preference = (args.browser as string) || 'auto';
  const port = typeof args.port === 'number' ? args.port : 9222;
  const url = (args.url as string) || '';

  const browser = findBrowser(preference);
  if (!browser) {
    return {
      content: JSON.stringify({ error: `No browser found. Tried: ${preference}. Install Chrome or Edge.` }),
      isError: true,
    };
  }

  const launchArgs = [`--remote-debugging-port=${port}`];
  if (url) launchArgs.push(url);

  try {
    const child = spawn(browser.path, launchArgs, { detached: true, stdio: 'ignore' });
    child.unref();

    const cdpEndpoint = `http://localhost:${port}`;

    // Wait a moment for the browser to start and open the CDP port
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Auto-start @playwright/mcp connected to this browser
    try {
      await startServer({
        name: 'Playwright',
        transport_type: 'stdio',
        command: 'npx',
        args: ['@playwright/mcp', '--cdp-endpoint', cdpEndpoint],
      });

      // Notify renderer to re-register tools (picks up new Playwright tools)
      const mainWindow = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
      if (mainWindow) {
        mainWindow.webContents.send('mcp:tools-changed');
      }
    } catch (mcpErr: any) {
      console.error('[AppTools] Failed to start Playwright MCP server:', mcpErr);
      // Browser launched successfully, just MCP failed — still report success
    }

    return {
      content: JSON.stringify({
        status: 'ok',
        browser: browser.name,
        cdp_endpoint: cdpEndpoint,
        message: `Launched ${browser.name} with CDP on port ${port}. Playwright MCP server connected — browser tools are now available.`,
      }),
      isError: false,
    };
  } catch (e: any) {
    return { content: JSON.stringify({ error: e.message }), isError: true };
  }
}

// --- IPC: forward tool calls to renderer ---

// Pending calls waiting for renderer response
let callCounter = 0;
const pendingCalls = new Map<number, { resolve: (result: any) => void; timer: ReturnType<typeof setTimeout> }>();

async function executeAppTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  if (name === 'app_launch_browser') {
    return executeLaunchBrowser(args);
  }

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
    mainWindow.webContents.send('app-tools:execute', { callId, name, args });
  });
}

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
      return executeAppTool(name, args);
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

export { APP_TOOL_NAMES, getAppToolSchemas, executeAppTool };
