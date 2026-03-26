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

import { ipcMain, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import * as fsOps from './fsOps';

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

// Pending approval requests waiting for renderer response
const pendingApprovals = new Map<string, (decision: ApprovalDecision) => void>();

async function showApprovalDialog(ruleKey: string, detail: string): Promise<ApprovalDecision> {
  const mainWindow = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!mainWindow) return 'deny';

  const approvalId = `host-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return new Promise<ApprovalDecision>((resolve) => {
    pendingApprovals.set(approvalId, resolve);

    mainWindow.webContents.send('host-tool-approval-request', {
      approvalId,
      ruleKey,
      detail,
      options: ['Accept', 'Auto-Accept for this session', 'Always Accept', 'Deny'],
    });

    // 5 minute timeout
    setTimeout(() => {
      if (pendingApprovals.has(approvalId)) {
        pendingApprovals.delete(approvalId);
        resolve('deny');
      }
    }, 300_000);
  });
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
          'Read a file from the host machine. ' +
          'Use start_line/end_line to read a specific range. ' +
          'When given a file reference like [path:10-20], pass start_line=10 and end_line=20.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the file.' },
            start_line: { type: 'integer', description: 'First line to read, 1-based (default: 1).' },
            end_line: { type: 'integer', description: 'Last line to read, inclusive (default: end of file).' },
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

// --- Tool execution (delegates to shared fsOps) ---

type ToolResult = { content: string; isError: boolean };

function ok(data: unknown): ToolResult {
  return { content: JSON.stringify(data), isError: false };
}
function err(msg: string): ToolResult {
  return { content: JSON.stringify({ error: msg }), isError: true };
}

async function executeHostRead(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const filePath = args.path as string;
    if (!filePath) return err('path is required.');

    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return err(`File not found: ${filePath}`);
    if (fs.statSync(resolved).isDirectory()) return err('Cannot read a directory.');

    const text = fs.readFileSync(resolved, { encoding: 'utf-8' });
    readFiles.add(resolved);

    const lines = text.split('\n');
    const startLine = typeof args.start_line === 'number' ? Math.max(1, args.start_line) : 1;
    const endLine = typeof args.end_line === 'number' ? Math.min(args.end_line, lines.length) : lines.length;
    const selected = lines.slice(startLine - 1, endLine);
    const content = selected.join('\n');

    if (endLine < lines.length || startLine > 1) {
      return { content: content + `\n\n[Lines ${startLine}-${endLine} of ${lines.length}]`, isError: false };
    }
    return { content, isError: false };
  } catch (e: any) { return err(e.message); }
}

/** Send diff view to renderer for display (non-blocking, just visual context). */
function sendDiffView(filePath: string, originalContent: string, modifiedContent: string) {
  const mainWindow = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!mainWindow) return;
  mainWindow.webContents.send('host-tools:diff-review', {
    reviewId: '', // Not used for approval — just display
    filePath,
    fileName: path.basename(filePath),
    originalContent,
    modifiedContent,
  });
}

/** Clear diff view in renderer. */
function clearDiffView() {
  const mainWindow = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!mainWindow) return;
  mainWindow.webContents.send('host-tools:diff-clear');
}

async function executeHostWrite(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const filePath = args.path as string;
    const content = args.content as string;
    if (!filePath) return err('path is required.');
    if (content === undefined || content === null) return err('content is required.');

    const result = fsOps.writeFile(filePath, content);
    readFiles.add(result.path);
    clearDiffView();
    return ok({ status: 'ok', path: filePath, bytes: result.bytes });
  } catch (e: any) { clearDiffView(); return err(e.message); }
}

async function executeHostEdit(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const filePath = args.path as string;
    const oldText = args.old_text as string;
    const newText = args.new_text as string;
    if (!filePath) return err('path is required.');
    if (!oldText) return err('old_text is required.');
    if (newText === undefined || newText === null) return err('new_text is required.');
    if (!readFiles.has(path.resolve(filePath))) return err('Must read the file with host_read before editing.');

    // Read the full file to build diff context
    const resolved = path.resolve(filePath);
    const fullContent = fs.readFileSync(resolved, { encoding: 'utf-8' });
    if (!fullContent.includes(oldText)) return err('old_text not found in file.');
    const newContent = fullContent.replace(oldText, newText);

    fs.writeFileSync(resolved, newContent, { encoding: 'utf-8' });
    clearDiffView();
    return ok({ status: 'ok', path: filePath });
  } catch (e: any) { clearDiffView(); return err(e.message); }
}

async function executeHostSearch(args: Record<string, unknown>, allowedPaths: string[]): Promise<ToolResult> {
  try {
    const query = args.query as string;
    if (!query) return err('query is required.');
    const searchPath = args.path as string || (allowedPaths.length > 0 ? allowedPaths[0] : null);
    if (!searchPath) return err('path is required when no allowed paths are configured.');
    const result = await fsOps.search(query, searchPath, args.glob as string | undefined, 100);
    if (result.error) return err(result.error);
    return ok({ matches: result.matches });
  } catch (e: any) { return err(e.message); }
}

async function executeHostList(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const dirPath = args.path as string;
    if (!dirPath) return err('path is required.');
    const entries = fsOps.listDirectory(dirPath, true);
    const items = entries.map((e) => ({
      name: e.name,
      type: e.type,
      ...(e.type === 'file' ? { size: e.size } : {}),
    }));
    return ok({ path: dirPath, entries: items, count: items.length });
  } catch (e: any) { return err(e.message); }
}

async function executeHostBash(args: Record<string, unknown>, allowedPaths: string[]): Promise<ToolResult> {
  try {
    const command = args.command as string;
    if (!command) return err('command is required.');
    const workdir = args.workdir
      ? path.resolve(args.workdir as string)
      : (allowedPaths.length > 0 ? path.resolve(allowedPaths[0]) : undefined);
    const timeout = typeof args.timeout === 'number' ? args.timeout : 60;
    const result = await fsOps.bash(command, workdir, timeout);
    return ok(result);
  } catch (e: any) { return err(e.message); }
}

// --- Main dispatch with approval gate ---

async function executeHostTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const allowedPaths = getAllowedPaths();

  // Show diff view before approval gate for write/edit operations
  if (name === 'host_write' || name === 'host_edit') {
    try {
      const filePath = args.path as string;
      if (filePath) {
        const resolved = path.resolve(filePath);
        if (name === 'host_write') {
          const original = fs.existsSync(resolved) ? fs.readFileSync(resolved, { encoding: 'utf-8' }) : '';
          sendDiffView(filePath, original, args.content as string || '');
        } else {
          // host_edit: compute the diff
          const fullContent = fs.existsSync(resolved) ? fs.readFileSync(resolved, { encoding: 'utf-8' }) : '';
          const oldText = args.old_text as string || '';
          const newText = args.new_text as string || '';
          if (fullContent.includes(oldText)) {
            sendDiffView(filePath, fullContent, fullContent.replace(oldText, newText));
          }
        }
      }
    } catch { /* ignore diff display errors */ }
  }

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
    clearDiffView();
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

  ipcMain.on('host-tool-approval-response', (_event, approvalId: string, decision: string) => {
    const resolve = pendingApprovals.get(approvalId);
    if (resolve) {
      pendingApprovals.delete(approvalId);
      // Map renderer values to internal ApprovalDecision
      const mapping: Record<string, ApprovalDecision> = {
        'accept': 'once',
        'auto-accept_for_this_session': 'session',
        'always_accept': 'always',
        'deny': 'deny',
      };
      resolve(mapping[decision] || 'deny');
    }
  });
}

export { HOST_TOOL_NAMES, getHostToolSchemas, executeHostTool };
