/**
 * Built-in host machine tools — file read/write/edit, search (rg), and bash.
 *
 * Approval gate with 4 levels per tool call:
 *   - Deny:    reject this call
 *   - Once:    approve this call, ask again next time
 *   - Session: approve for this tool until app restart
 *   - Always:  persist approval (path tools → add dir to allowed_paths,
 *              other tools → persistent tool policy)
 *
 * Cross-platform: Windows + Linux.
 */

import { ipcMain, dialog, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { app } from 'electron';

// --- Settings persistence ---

const settingsPath = path.join(app.getPath('userData'), 'settings.json');

function loadSettings(): Record<string, any> {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); }
  catch { return {}; }
}

function saveSettings(settings: Record<string, any>): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

// --- Global allowed paths (persistent path-level approval, shared across all agents) ---

function getAllowedPaths(): string[] {
  const settings = loadSettings();
  return Array.isArray(settings['allowed_paths']) ? settings['allowed_paths'] : [];
}

function setAllowedPaths(paths: string[]): void {
  const settings = loadSettings();
  settings['allowed_paths'] = paths;
  saveSettings(settings);
}

function addAllowedPath(dirPath: string): void {
  const paths = getAllowedPaths();
  const resolved = path.resolve(dirPath);
  if (!paths.some((p) => path.resolve(p) === resolved)) {
    paths.push(resolved);
    setAllowedPaths(paths);
  }
}

// --- Global persistent tool policies ---

function getToolPolicies(): Record<string, 'auto' | 'deny'> {
  const settings = loadSettings();
  return settings['tool_policies'] || {};
}

function getToolPolicy(toolName: string): 'auto' | 'deny' | null {
  return getToolPolicies()[toolName] || null;
}

function setToolPolicy(toolName: string, policy: 'auto' | 'deny'): void {
  const settings = loadSettings();
  const policies = settings['tool_policies'] || {};
  policies[toolName] = policy;
  settings['tool_policies'] = policies;
  saveSettings(settings);
}

function removeToolPolicy(toolName: string): void {
  const settings = loadSettings();
  const policies = settings['tool_policies'] || {};
  delete policies[toolName];
  settings['tool_policies'] = policies;
  saveSettings(settings);
}

// --- Session approvals (in-memory, cleared on restart) ---

const sessionApprovals = new Set<string>(); // tool names

function hasSessionApproval(toolName: string): boolean {
  return sessionApprovals.has(toolName);
}

function addSessionApproval(toolName: string): void {
  sessionApprovals.add(toolName);
}

function getSessionApprovals(): string[] {
  return Array.from(sessionApprovals);
}

function clearSessionApprovals(): void {
  sessionApprovals.clear();
}

// --- Path helpers ---

function isPathAllowed(filePath: string, allowedPaths: string[]): boolean {
  if (allowedPaths.length === 0) return false;
  const resolved = path.resolve(filePath);
  return allowedPaths.some((allowed) => {
    const allowedResolved = path.resolve(allowed);
    return resolved === allowedResolved || resolved.startsWith(allowedResolved + path.sep);
  });
}

// --- Generic approval gate ---

type ApprovalDecision = 'deny' | 'once' | 'session' | 'always';

/**
 * Derive the rule key for a tool call.
 *
 * - host_list, host_search: key includes the resolved directory path
 *   so approval is per-folder (e.g. "host_list:/home/user/project").
 * - host_bash: key includes the base command (first word)
 *   so each command is tracked separately (e.g. "host_bash:git").
 * - Others (host_read, host_write, host_edit): just the tool name;
 *   path-level approval is handled via allowed_paths.
 */
function getRuleKey(toolName: string, args: Record<string, unknown>, allowedPaths: string[]): string {
  if (toolName === 'host_list' || toolName === 'host_search') {
    const targetPath = args.path as string | undefined;
    const effective = targetPath
      ? path.resolve(targetPath)
      : (allowedPaths.length > 0 ? path.resolve(allowedPaths[0]) : null);
    if (effective) return `${toolName}:${effective}`;
  }
  if (toolName === 'host_bash') {
    const command = (args.command as string || '').trim();
    const baseCmd = command.split(/[\s;&|]/)[0].replace(/^.*[/\\]/, ''); // strip path
    if (baseCmd) return `host_bash:${baseCmd}`;
  }
  return toolName;
}

function describeToolCall(name: string, args: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    lines.push(`${key}: ${str.length > 300 ? str.substring(0, 300) + '...' : str}`);
  }
  return lines.join('\n');
}

async function showApprovalDialog(ruleKey: string, detail: string): Promise<ApprovalDecision> {
  const mainWindow = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!mainWindow) return 'deny';

  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Tool Approval',
    message: `An agent wants to use ${ruleKey}:`,
    detail,
    buttons: ['Deny', 'Once', 'This Session', 'Always'],
    defaultId: 0,
    cancelId: 0,
  });

  return (['deny', 'once', 'session', 'always'] as const)[result.response];
}

/**
 * Generic tool call gate.
 *
 * @param autoApprove  — return true to skip the dialog entirely
 *
 * Checks in order: persistent policy → session → autoApprove condition → dialog.
 * Dialog result is stored according to the user's choice.
 */
async function gateToolCall(
  toolName: string,
  args: Record<string, unknown>,
  allowedPaths: string[],
  autoApprove: () => boolean,
): Promise<boolean> {
  const ruleKey = getRuleKey(toolName, args, allowedPaths);

  // 1. Persistent tool policy
  const policy = getToolPolicy(ruleKey);
  if (policy === 'auto') return true;
  if (policy === 'deny') return false;

  // 2. Session approval
  if (hasSessionApproval(ruleKey)) return true;

  // 3. Caller-defined auto-approve condition (e.g. path in allowed_paths)
  if (autoApprove()) return true;

  // 4. Prompt user
  const decision = await showApprovalDialog(ruleKey, describeToolCall(toolName, args));

  switch (decision) {
    case 'deny':
      return false;
    case 'once':
      return true;
    case 'session':
      addSessionApproval(ruleKey);
      return true;
    case 'always': {
      // For path-based tools: add the parent directory to allowed_paths
      const targetPath = args.path as string | undefined;
      if (targetPath && toolName !== 'host_bash') {
        const resolved = path.resolve(targetPath);
        const dirToAdd = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
          ? resolved
          : path.dirname(resolved);
        addAllowedPath(dirToAdd);
      } else {
        // Bash and non-path tools: persist rule-key-level policy
        setToolPolicy(ruleKey, 'auto');
      }
      return true;
    }
  }
}

// --- Read tracking for edit-requires-read ---

const readFiles = new Set<string>();

// --- Tool schemas ---

interface ToolSchema {
  type: string;
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const HOST_TOOL_NAMES = new Set(['host_read', 'host_write', 'host_edit', 'host_search', 'host_list', 'host_bash']);

function getHostToolSchemas(): ToolSchema[] {
  return [
    {
      type: 'function',
      function: {
        name: 'host_read',
        description:
          'Read a file from the host machine at an absolute path. ' +
          'Returns content with line numbers. Use offset/limit for large files.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the file.' },
            offset: { type: 'integer', description: 'Starting line number, 0-based (default: 0).' },
            limit: { type: 'integer', description: 'Maximum lines to return (default: 500).' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'host_write',
        description:
          'Create or overwrite a file on the host machine. ' +
          'Automatically creates parent directories if needed.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path for the file.' },
            content: { type: 'string', description: 'Full file content to write.' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'host_edit',
        description:
          'Edit a file on the host machine by replacing text. ' +
          'Must read the file first with host_read. ' +
          'The old_text must match exactly one location in the file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the file.' },
            old_text: { type: 'string', description: 'Exact text to find and replace.' },
            new_text: { type: 'string', description: 'Replacement text.' },
          },
          required: ['path', 'old_text', 'new_text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'host_search',
        description:
          'Search file contents on the host machine using ripgrep (rg). ' +
          'Returns matching lines with file path, line number, and snippet.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Text or regex pattern to search for.' },
            path: { type: 'string', description: 'Directory to search in (default: first allowed path).' },
            glob: { type: 'string', description: 'File pattern filter, e.g. "*.ts", "*.py".' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'host_list',
        description:
          'List files and directories in a folder on the host machine. ' +
          'Returns name, type (file/directory), and size for each entry.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the directory.' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'host_bash',
        description:
          'Execute a shell command on the host machine. ' +
          'Requires user approval before execution. ' +
          'Returns stdout, stderr, and exit code.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The shell command to execute.' },
            workdir: { type: 'string', description: 'Working directory (default: first allowed path).' },
            timeout: { type: 'integer', description: 'Timeout in seconds (default: 60, max: 300).' },
          },
          required: ['command'],
        },
      },
    },
  ];
}

// --- Tool execution (pure — no approval logic) ---

const MAX_OUTPUT_BYTES = 100 * 1024; // 100KB output cap

async function executeHostRead(args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
  try {
    const filePath = args.path as string;
    if (!filePath) return { content: JSON.stringify({ error: 'path is required.' }), isError: true };

    const resolved = path.resolve(filePath);

    if (!fs.existsSync(resolved)) {
      return { content: JSON.stringify({ error: `File not found: ${filePath}` }), isError: true };
    }
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      return { content: JSON.stringify({ error: 'Cannot read a directory. Provide a file path.' }), isError: true };
    }

    const offset = typeof args.offset === 'number' ? args.offset : 0;
    const limit = typeof args.limit === 'number' ? args.limit : 500;

    const text = fs.readFileSync(resolved, { encoding: 'utf-8' });
    const lines = text.split('\n');
    const totalLines = lines.length;
    const selected = lines.slice(offset, offset + limit);

    const numbered = selected.map((line, i) => `${offset + i + 1}\t${line}`).join('\n');
    readFiles.add(resolved);

    const result: Record<string, unknown> = { content: numbered, total_lines: totalLines };
    if (offset + limit < totalLines) {
      result.truncated = true;
      result.next_offset = offset + limit;
    }

    return { content: JSON.stringify(result), isError: false };
  } catch (e: any) {
    return { content: JSON.stringify({ error: e.message }), isError: true };
  }
}

async function executeHostWrite(args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
  try {
    const filePath = args.path as string;
    const content = args.content as string;
    if (!filePath) return { content: JSON.stringify({ error: 'path is required.' }), isError: true };
    if (content === undefined || content === null) return { content: JSON.stringify({ error: 'content is required.' }), isError: true };

    const resolved = path.resolve(filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, { encoding: 'utf-8' });
    readFiles.add(resolved);

    const bytes = Buffer.byteLength(content, 'utf-8');
    return { content: JSON.stringify({ status: 'ok', path: filePath, bytes }), isError: false };
  } catch (e: any) {
    return { content: JSON.stringify({ error: e.message }), isError: true };
  }
}

async function executeHostEdit(args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
  try {
    const filePath = args.path as string;
    const oldText = args.old_text as string;
    const newText = args.new_text as string;
    if (!filePath) return { content: JSON.stringify({ error: 'path is required.' }), isError: true };
    if (!oldText) return { content: JSON.stringify({ error: 'old_text is required.' }), isError: true };
    if (newText === undefined || newText === null) return { content: JSON.stringify({ error: 'new_text is required.' }), isError: true };

    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      return { content: JSON.stringify({ error: `File not found: ${filePath}` }), isError: true };
    }
    if (!readFiles.has(resolved)) {
      return { content: JSON.stringify({ error: 'Must read the file with host_read before editing.' }), isError: true };
    }

    const content = fs.readFileSync(resolved, { encoding: 'utf-8' });
    if (!content.includes(oldText)) {
      return { content: JSON.stringify({ error: 'old_text not found in file.' }), isError: true };
    }

    const count = content.split(oldText).length - 1;
    if (count > 1) {
      return { content: JSON.stringify({ error: `old_text matches ${count} locations. Provide more context to make it unique.` }), isError: true };
    }

    const newContent = content.replace(oldText, newText);
    fs.writeFileSync(resolved, newContent, { encoding: 'utf-8' });

    return { content: JSON.stringify({ status: 'ok', path: filePath }), isError: false };
  } catch (e: any) {
    return { content: JSON.stringify({ error: e.message }), isError: true };
  }
}

async function executeHostSearch(args: Record<string, unknown>, allowedPaths: string[]): Promise<{ content: string; isError: boolean }> {
  try {
    const query = args.query as string;
    if (!query) return { content: JSON.stringify({ error: 'query is required.' }), isError: true };

    let searchPath: string;
    if (args.path) {
      searchPath = path.resolve(args.path as string);
    } else if (allowedPaths.length > 0) {
      searchPath = path.resolve(allowedPaths[0]);
    } else {
      return { content: JSON.stringify({ error: 'path is required when no allowed paths are configured.' }), isError: true };
    }

    if (!fs.existsSync(searchPath) || !fs.statSync(searchPath).isDirectory()) {
      return { content: JSON.stringify({ error: `Directory not found: ${searchPath}` }), isError: true };
    }

    const rgArgs = ['--line-number', '--no-heading', '--max-count', '100'];
    if (args.glob) {
      rgArgs.push('--glob', args.glob as string);
    }
    rgArgs.push('--', query, searchPath);

    const cmd = ['rg', ...rgArgs.map(a => `"${a.replace(/"/g, '\\"')}"`)]  .join(' ');

    return new Promise((resolve) => {
      exec(cmd, { maxBuffer: MAX_OUTPUT_BYTES, timeout: 30000 }, (error, stdout, stderr) => {
        if (error && !stdout) {
          if (error.code === 1) {
            resolve({ content: JSON.stringify({ matches: [], message: 'No matches found.' }), isError: false });
            return;
          }
          resolve({ content: JSON.stringify({ error: stderr || error.message }), isError: true });
          return;
        }

        const lines = stdout.trim().split('\n').filter(Boolean).slice(0, 100);
        const matches = lines.map((line) => {
          const firstColon = line.indexOf(':');
          const secondColon = line.indexOf(':', firstColon + 1);
          if (firstColon === -1 || secondColon === -1) {
            return { raw: line };
          }
          return {
            path: line.substring(0, firstColon),
            line: parseInt(line.substring(firstColon + 1, secondColon), 10),
            snippet: line.substring(secondColon + 1).trim().substring(0, 200),
          };
        });

        resolve({ content: JSON.stringify({ matches }), isError: false });
      });
    });
  } catch (e: any) {
    return { content: JSON.stringify({ error: e.message }), isError: true };
  }
}

async function executeHostList(args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
  try {
    const dirPath = args.path as string;
    if (!dirPath) return { content: JSON.stringify({ error: 'path is required.' }), isError: true };

    const resolved = path.resolve(dirPath);
    if (!fs.existsSync(resolved)) {
      return { content: JSON.stringify({ error: `Directory not found: ${dirPath}` }), isError: true };
    }
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return { content: JSON.stringify({ error: `Not a directory: ${dirPath}` }), isError: true };
    }

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const items = entries.map((entry) => {
      const entryPath = path.join(resolved, entry.name);
      const item: Record<string, unknown> = {
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
      };
      try {
        const s = fs.statSync(entryPath);
        if (!entry.isDirectory()) item.size = s.size;
      } catch { /* skip stat errors */ }
      return item;
    });

    return { content: JSON.stringify({ path: dirPath, entries: items, count: items.length }), isError: false };
  } catch (e: any) {
    return { content: JSON.stringify({ error: e.message }), isError: true };
  }
}

async function executeHostBash(
  args: Record<string, unknown>,
  allowedPaths: string[],
): Promise<{ content: string; isError: boolean }> {
  try {
    const command = args.command as string;
    if (!command) return { content: JSON.stringify({ error: 'command is required.' }), isError: true };

    let workdir: string | undefined;
    if (args.workdir) {
      workdir = path.resolve(args.workdir as string);
    } else if (allowedPaths.length > 0) {
      workdir = path.resolve(allowedPaths[0]);
    }

    let timeout = typeof args.timeout === 'number' ? args.timeout : 60;
    timeout = Math.max(1, Math.min(timeout, 300));

    return new Promise((resolve) => {
      exec(
        command,
        {
          cwd: workdir,
          maxBuffer: MAX_OUTPUT_BYTES,
          timeout: timeout * 1000,
        },
        (error, stdout, stderr) => {
          const timedOut = error && 'killed' in error && error.killed === true;
          resolve({
            content: JSON.stringify({
              exit_code: error ? (error as any).code ?? 1 : 0,
              stdout: stdout.substring(0, MAX_OUTPUT_BYTES),
              stderr: stderr.substring(0, MAX_OUTPUT_BYTES),
              timed_out: timedOut || false,
            }),
            isError: false,
          });
        },
      );
    });
  } catch (e: any) {
    return { content: JSON.stringify({ error: e.message }), isError: true };
  }
}

// --- Main dispatch with approval gate ---

async function executeHostTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const allowedPaths = getAllowedPaths();

  const approved = await gateToolCall(name, args, allowedPaths, () => {
    // Bash: never auto-approve (always goes to policy/session/dialog checks)
    if (name === 'host_bash') return false;

    // Path-based tools: auto-approve if target path is within allowed_paths
    const targetPath = args.path as string | undefined;
    if (targetPath) return isPathAllowed(targetPath, allowedPaths);

    // No explicit path (e.g. host_search defaults to first allowed path)
    return allowedPaths.length > 0;
  });

  if (!approved) {
    return { content: JSON.stringify({ error: 'Denied by user.' }), isError: true };
  }

  switch (name) {
    case 'host_read':
      return executeHostRead(args);
    case 'host_write':
      return executeHostWrite(args);
    case 'host_edit':
      return executeHostEdit(args);
    case 'host_search':
      return executeHostSearch(args, allowedPaths);
    case 'host_list':
      return executeHostList(args);
    case 'host_bash':
      return executeHostBash(args, allowedPaths);
    default:
      return { content: `Unknown host tool: ${name}`, isError: true };
  }
}

// --- IPC registration ---

export function registerHostToolIPC(): void {
  ipcMain.handle('host-tools:list-tools', () => {
    return getHostToolSchemas();
  });

  ipcMain.handle(
    'host-tools:call-tool',
    async (_event, name: string, args: Record<string, unknown>) => {
      return executeHostTool(name, args);
    },
  );

  ipcMain.handle('host-tools:get-allowed-paths', () => {
    return getAllowedPaths();
  });

  ipcMain.handle('host-tools:set-allowed-paths', (_event, paths: string[]) => {
    setAllowedPaths(paths);
  });

  ipcMain.handle('host-tools:get-tool-policies', () => {
    return getToolPolicies();
  });

  ipcMain.handle('host-tools:remove-tool-policy', (_event, toolName: string) => {
    removeToolPolicy(toolName);
  });

  ipcMain.handle('host-tools:get-session-approvals', () => {
    return getSessionApprovals();
  });

  ipcMain.handle('host-tools:clear-session-approvals', () => {
    clearSessionApprovals();
  });

  ipcMain.handle('host-tools:is-host-tool', (_event, name: string) => {
    return HOST_TOOL_NAMES.has(name);
  });
}

export { HOST_TOOL_NAMES, getHostToolSchemas };
