/**
 * Built-in host machine tools — file read/write/edit, search (rg), and bash.
 *
 * Sandbox: per-agent allowed_paths stored in settings.json.
 * File tools auto-execute within allowed paths; bash always requires approval dialog.
 * Cross-platform: Windows + Linux.
 */

import { ipcMain, dialog, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { app } from 'electron';

// --- Settings persistence (shared with main.ts pattern) ---

const settingsPath = path.join(app.getPath('userData'), 'settings.json');

function loadSettings(): Record<string, any> {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); }
  catch { return {}; }
}

function saveSettings(settings: Record<string, any>): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function getAllowedPaths(agentId: number): string[] {
  const settings = loadSettings();
  const key = `allowed_paths_${agentId}`;
  return Array.isArray(settings[key]) ? settings[key] : [];
}

function setAllowedPaths(agentId: number, paths: string[]): void {
  const settings = loadSettings();
  settings[`allowed_paths_${agentId}`] = paths;
  saveSettings(settings);
}

// --- Sandbox validation ---

function validatePath(filePath: string, allowedPaths: string[]): string {
  if (allowedPaths.length === 0) {
    throw new Error('No allowed paths configured for this agent. Configure allowed directories in Tools settings.');
  }

  const resolved = path.resolve(filePath);
  for (const allowed of allowedPaths) {
    const allowedResolved = path.resolve(allowed);
    // Check if resolved path is the allowed dir itself or inside it
    if (resolved === allowedResolved || resolved.startsWith(allowedResolved + path.sep)) {
      return resolved;
    }
  }

  throw new Error(`Path not within allowed directories: ${filePath}`);
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

const HOST_TOOL_NAMES = new Set(['host_read', 'host_write', 'host_edit', 'host_search', 'host_bash']);

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

// --- Tool execution ---

const MAX_OUTPUT_BYTES = 100 * 1024; // 100KB output cap

async function executeHostRead(args: Record<string, unknown>, allowedPaths: string[]): Promise<{ content: string; isError: boolean }> {
  try {
    const filePath = args.path as string;
    if (!filePath) return { content: JSON.stringify({ error: 'path is required.' }), isError: true };

    const resolved = validatePath(filePath, allowedPaths);

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

    // Format with line numbers
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

async function executeHostWrite(args: Record<string, unknown>, allowedPaths: string[]): Promise<{ content: string; isError: boolean }> {
  try {
    const filePath = args.path as string;
    const content = args.content as string;
    if (!filePath) return { content: JSON.stringify({ error: 'path is required.' }), isError: true };
    if (content === undefined || content === null) return { content: JSON.stringify({ error: 'content is required.' }), isError: true };

    const resolved = validatePath(filePath, allowedPaths);

    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, { encoding: 'utf-8' });
    readFiles.add(resolved);

    const bytes = Buffer.byteLength(content, 'utf-8');
    return { content: JSON.stringify({ status: 'ok', path: filePath, bytes }), isError: false };
  } catch (e: any) {
    return { content: JSON.stringify({ error: e.message }), isError: true };
  }
}

async function executeHostEdit(args: Record<string, unknown>, allowedPaths: string[]): Promise<{ content: string; isError: boolean }> {
  try {
    const filePath = args.path as string;
    const oldText = args.old_text as string;
    const newText = args.new_text as string;
    if (!filePath) return { content: JSON.stringify({ error: 'path is required.' }), isError: true };
    if (!oldText) return { content: JSON.stringify({ error: 'old_text is required.' }), isError: true };
    if (newText === undefined || newText === null) return { content: JSON.stringify({ error: 'new_text is required.' }), isError: true };

    const resolved = validatePath(filePath, allowedPaths);

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
      searchPath = validatePath(args.path as string, allowedPaths);
    } else {
      if (allowedPaths.length === 0) {
        return { content: JSON.stringify({ error: 'No allowed paths configured.' }), isError: true };
      }
      searchPath = path.resolve(allowedPaths[0]);
    }

    if (!fs.existsSync(searchPath) || !fs.statSync(searchPath).isDirectory()) {
      return { content: JSON.stringify({ error: `Directory not found: ${searchPath}` }), isError: true };
    }

    // Build rg command
    const rgArgs = ['--line-number', '--no-heading', '--max-count', '100'];
    if (args.glob) {
      rgArgs.push('--glob', args.glob as string);
    }
    rgArgs.push('--', query, searchPath);

    const cmd = ['rg', ...rgArgs.map(a => `"${a.replace(/"/g, '\\"')}"`)]  .join(' ');

    return new Promise((resolve) => {
      exec(cmd, { maxBuffer: MAX_OUTPUT_BYTES, timeout: 30000 }, (error, stdout, stderr) => {
        if (error && !stdout) {
          // rg exits with code 1 when no matches found
          if (error.code === 1) {
            resolve({ content: JSON.stringify({ matches: [], message: 'No matches found.' }), isError: false });
            return;
          }
          resolve({ content: JSON.stringify({ error: stderr || error.message }), isError: true });
          return;
        }

        const lines = stdout.trim().split('\n').filter(Boolean).slice(0, 100);
        const matches = lines.map((line) => {
          // rg output format: file:line:content
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

async function executeHostBash(
  args: Record<string, unknown>,
  allowedPaths: string[],
): Promise<{ content: string; isError: boolean }> {
  try {
    const command = args.command as string;
    if (!command) return { content: JSON.stringify({ error: 'command is required.' }), isError: true };

    let workdir: string | undefined;
    if (args.workdir) {
      workdir = validatePath(args.workdir as string, allowedPaths);
    } else if (allowedPaths.length > 0) {
      workdir = path.resolve(allowedPaths[0]);
    }

    let timeout = typeof args.timeout === 'number' ? args.timeout : 60;
    timeout = Math.max(1, Math.min(timeout, 300));

    // Show approval dialog
    const mainWindow = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
    if (!mainWindow) {
      return { content: JSON.stringify({ error: 'No window available for approval dialog.' }), isError: true };
    }

    const approval = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Shell Command Approval',
      message: 'An agent wants to run a shell command:',
      detail: `Command: ${command}\nDirectory: ${workdir || '(default)'}\nTimeout: ${timeout}s`,
      buttons: ['Deny', 'Approve'],
      defaultId: 0,
      cancelId: 0,
    });

    if (approval.response !== 1) {
      return { content: JSON.stringify({ error: 'Command denied by user.' }), isError: true };
    }

    // Execute
    return new Promise((resolve) => {
      const timeoutMs = timeout * 1000;
      exec(
        command,
        {
          cwd: workdir,
          maxBuffer: MAX_OUTPUT_BYTES,
          timeout: timeoutMs,
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

// --- Main dispatch ---

async function executeHostTool(
  name: string,
  args: Record<string, unknown>,
  agentId: number,
): Promise<{ content: string; isError: boolean }> {
  const allowedPaths = getAllowedPaths(agentId);

  switch (name) {
    case 'host_read':
      return executeHostRead(args, allowedPaths);
    case 'host_write':
      return executeHostWrite(args, allowedPaths);
    case 'host_edit':
      return executeHostEdit(args, allowedPaths);
    case 'host_search':
      return executeHostSearch(args, allowedPaths);
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
    async (_event, name: string, args: Record<string, unknown>, agentId: number) => {
      return executeHostTool(name, args, agentId);
    },
  );

  ipcMain.handle('host-tools:get-allowed-paths', (_event, agentId: number) => {
    return getAllowedPaths(agentId);
  });

  ipcMain.handle('host-tools:set-allowed-paths', (_event, agentId: number, paths: string[]) => {
    setAllowedPaths(agentId, paths);
  });

  ipcMain.handle('host-tools:is-host-tool', (_event, name: string) => {
    return HOST_TOOL_NAMES.has(name);
  });

  ipcMain.handle('host-tools:list-directory', (_event, dirPath: string, agentId: number) => {
    const allowedPaths = getAllowedPaths(agentId);

    // Root: return allowed paths as top-level entries
    if (!dirPath) {
      return {
        path: '',
        entries: allowedPaths.map(p => ({
          name: path.basename(p) || p,
          fullPath: path.resolve(p),
          type: 'directory' as const,
          size: 0,
          modified: null,
          extension: '',
        })),
        isRoot: true,
      };
    }

    try {
      const resolved = validatePath(dirPath, allowedPaths);
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return { path: resolved, entries: [], isRoot: false, error: 'Not a directory' };
      }

      const dirEntries = fs.readdirSync(resolved, { withFileTypes: true });
      const entries = dirEntries
        .filter(e => !e.name.startsWith('.'))
        .map(entry => {
          const fullPath = path.join(resolved, entry.name);
          let size = 0;
          let modified: string | null = null;
          try {
            const s = fs.statSync(fullPath);
            size = s.size;
            modified = s.mtime.toISOString();
          } catch {}
          return {
            name: entry.name,
            fullPath,
            type: (entry.isDirectory() ? 'directory' : 'file') as 'directory' | 'file',
            size,
            modified,
            extension: entry.isFile() ? path.extname(entry.name) : '',
          };
        })
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      return { path: resolved, entries, isRoot: false };
    } catch (e: any) {
      return { path: dirPath, entries: [], isRoot: false, error: e.message };
    }
  });

  ipcMain.handle('host-tools:read-file', async (_event, filePath: string, agentId: number) => {
    const allowedPaths = getAllowedPaths(agentId);
    try {
      const resolved = validatePath(filePath, allowedPaths);
      const content = fs.readFileSync(resolved, { encoding: 'utf-8' });
      return { content, path: resolved };
    } catch (e: any) {
      return { error: e.message };
    }
  });

  ipcMain.handle('host-tools:write-file', async (_event, filePath: string, content: string, agentId: number) => {
    const allowedPaths = getAllowedPaths(agentId);
    try {
      const resolved = validatePath(filePath, allowedPaths);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, { encoding: 'utf-8' });
      return { status: 'ok', path: resolved };
    } catch (e: any) {
      return { error: e.message };
    }
  });
}

export { HOST_TOOL_NAMES, getHostToolSchemas };
