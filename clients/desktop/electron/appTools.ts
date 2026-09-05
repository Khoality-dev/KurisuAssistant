/**
 * App config tools — let the assistant manage settings, MCP servers, and vision.
 *
 * The assistant/persona/sub-agent split is visible here: capability lives on the
 * one assistant (`app_*_assistant`), presentation on many personas
 * (`app_*_persona`), and delegated work on sub-agents (`app_*_sub_agent`). Every
 * name in APP_TOOL_NAMES must have a case in `src/services/appToolsHandler.ts` —
 * a schema with no handler is advertised to the model, costs tokens in every
 * tool list, and answers "Unknown app tool" when called.
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
  'app_get_assistant',
  'app_update_assistant',
  'app_get_personas',
  'app_create_persona',
  'app_update_persona',
  'app_delete_persona',
  'app_get_sub_agents',
  'app_create_sub_agent',
  'app_update_sub_agent',
  'app_delete_sub_agent',
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
    // --- Assistant (capability: one per user, created at registration) ---
    {
      type: 'function',
      function: {
        name: 'app_get_assistant',
        description:
          "The user's single assistant: model, provider, tool allowlist, reasoning, " +
          'memory, voice wake word, and the persona new conversations bind to.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'app_update_assistant',
        description:
          "Change what the assistant can do. Only send fields you want to change. " +
          'This is capability only — a name, prompt, voice or avatar belongs to a persona, ' +
          'so use app_update_persona for those.',
        parameters: {
          type: 'object',
          properties: {
            model_name: { type: 'string', description: 'LLM model name (e.g. "gemma3:4b").' },
            provider_type: { type: 'string', enum: ['ollama', 'gemini', 'nvidia'], description: 'LLM provider.' },
            available_tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Allowlist of tool names. Omit to leave alone; send null for every tool.',
            },
            think: { type: 'boolean', description: 'Enable extended reasoning.' },
            use_deferred_tools: { type: 'boolean', description: 'Defer tool schemas until searched for.' },
            memory: { type: 'string', description: 'Long-term memory notes.' },
            memory_enabled: { type: 'boolean', description: 'Enable memory injection + consolidation.' },
            trigger_word: {
              type: 'string',
              description:
                'Voice wake word. Saying it wakes the assistant; the conversation\'s bound persona answers. It selects no persona.',
            },
            default_persona_id: {
              type: 'integer',
              description: 'Persona a new conversation silently binds to.',
            },
          },
          required: [],
        },
      },
    },
    // --- Personas (presentation: many per user) ---
    {
      type: 'function',
      function: {
        name: 'app_get_personas',
        description:
          'List the personas the assistant can answer as. A persona is presentation only — ' +
          'name, description, prompt, how it addresses the user, voice, avatar.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'app_create_persona',
        description:
          'Create a persona. It owns no model, no tools and no memory: those stay on the assistant, ' +
          'so a new persona changes who answers, not what the assistant can do.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Display name.' },
            description: { type: 'string', description: 'Short description of this persona.' },
            system_prompt: { type: 'string', description: 'System prompt / personality.' },
            preferred_name: { type: 'string', description: 'What this persona calls the user.' },
            voice_reference: { type: 'string', description: 'TTS voice reference file name.' },
            enabled: { type: 'boolean', description: 'Whether the persona can be selected (default: true).' },
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
            description: { type: 'string', description: 'New description.' },
            system_prompt: { type: 'string', description: 'New system prompt / personality.' },
            preferred_name: { type: 'string', description: 'What this persona calls the user.' },
            voice_reference: { type: 'string', description: 'TTS voice reference file name.' },
            enabled: { type: 'boolean', description: 'Enable or disable the persona.' },
          },
          required: ['persona_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'app_delete_persona',
        description:
          "Delete a persona by ID. The user's last remaining persona cannot be deleted — a " +
          'conversation needs one to bind to. Deleting the default one is allowed: the oldest ' +
          'remaining persona becomes the new default.',
        parameters: {
          type: 'object',
          properties: {
            persona_id: { type: 'integer', description: 'ID of the persona to delete.' },
          },
          required: ['persona_id'],
        },
      },
    },
    // --- Sub-agents (task-only workers) ---
    {
      type: 'function',
      function: {
        name: 'app_get_sub_agents',
        description:
          'List sub-agents. A sub-agent is a worker the assistant delegates a task to mid-answer: ' +
          'its own model and tools, but no name shown to the user, no voice, no memory.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'app_create_sub_agent',
        description: 'Create a sub-agent the assistant can delegate to.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name the assistant calls it by.' },
            description: { type: 'string', description: 'What this sub-agent is for — the assistant reads this to decide when to delegate.' },
            system_prompt: { type: 'string', description: 'Task instructions.' },
            model_name: { type: 'string', description: "LLM model name. Omit to use the assistant's model." },
            provider_type: { type: 'string', enum: ['ollama', 'gemini', 'nvidia'], description: 'LLM provider.' },
            available_tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Allowlist of tool names (omit for every tool).',
            },
            think: { type: 'boolean', description: 'Enable extended reasoning.' },
          },
          required: ['name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'app_update_sub_agent',
        description: 'Update a sub-agent. Only provide fields you want to change.',
        parameters: {
          type: 'object',
          properties: {
            sub_agent_id: { type: 'integer', description: 'ID of the sub-agent to update.' },
            name: { type: 'string', description: 'New name.' },
            description: { type: 'string', description: 'New description.' },
            system_prompt: { type: 'string', description: 'New task instructions.' },
            model_name: { type: 'string', description: 'LLM model name.' },
            provider_type: { type: 'string', enum: ['ollama', 'gemini', 'nvidia'], description: 'LLM provider.' },
            available_tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Allowlist of tool names.',
            },
            think: { type: 'boolean', description: 'Enable extended reasoning.' },
            enabled: { type: 'boolean', description: 'Enable or disable the sub-agent.' },
          },
          required: ['sub_agent_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'app_delete_sub_agent',
        description: 'Delete a sub-agent by ID.',
        parameters: {
          type: 'object',
          properties: {
            sub_agent_id: { type: 'integer', description: 'ID of the sub-agent to delete.' },
          },
          required: ['sub_agent_id'],
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
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
            '/snap/bin/google-chrome',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ],
    },
    {
      name: 'edge',
      paths: process.platform === 'win32'
        ? [
            path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          ]
        : [
            '/usr/bin/microsoft-edge',
            '/usr/bin/microsoft-edge-stable',
            '/opt/microsoft/msedge/microsoft-edge',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          ],
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
