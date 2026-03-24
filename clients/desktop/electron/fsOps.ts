/**
 * Shared filesystem operations used by both host tools (agent-facing, gated)
 * and explorer IPC (user-facing, direct). Pure functions — no approval logic.
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
// Resolve bundled ripgrep binary path.
// @vscode/ripgrep uses __dirname which breaks after vite bundles to dist-electron/.
// Resolve from node_modules directly at runtime.
function findRgPath(): string {
  const candidates = [
    // Dev: node_modules path
    path.join(process.cwd(), 'node_modules', '@vscode', 'ripgrep', 'bin', `rg${process.platform === 'win32' ? '.exe' : ''}`),
    // Packaged: unpacked from asar
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', '@vscode', 'ripgrep', 'bin', `rg${process.platform === 'win32' ? '.exe' : ''}`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      console.log('[fsOps] ripgrep binary found:', p);
      return p;
    }
  }
  // Fallback to system rg
  console.warn('[fsOps] bundled ripgrep not found, falling back to system rg');
  return 'rg';
}

const rgPath = findRgPath();

/** Shell-escape an argument for use in exec(). */
function shellEscape(arg: string): string {
  if (process.platform === 'win32') {
    // Windows cmd: wrap in double quotes, escape inner quotes and trailing backslash
    let escaped = arg.replace(/"/g, '\\"');
    // A trailing \ before the closing " would escape it — double it
    if (escaped.endsWith('\\')) escaped += '\\';
    return `"${escaped}"`;
  }
  // Unix: wrap in single quotes, escape inner single quotes
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

const MAX_OUTPUT_BYTES = 100 * 1024; // 100KB

// --- Types ---

export interface SearchMatch {
  path: string;
  line: number;
  snippet: string;
}

export interface ListEntry {
  name: string;
  fullPath: string;
  type: 'file' | 'directory';
  size: number;
  modified: string | null;
  extension: string;
}

// --- Read ---

export interface ReadResult {
  content: string;
  total_lines: number;
  truncated?: boolean;
  next_offset?: number;
}

export function readFile(filePath: string, offset = 0, limit = 500): ReadResult {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${filePath}`);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) throw new Error('Cannot read a directory. Provide a file path.');

  const text = fs.readFileSync(resolved, { encoding: 'utf-8' });
  const lines = text.split('\n');
  const totalLines = lines.length;
  const selected = lines.slice(offset, offset + limit);
  const numbered = selected.map((line, i) => `${offset + i + 1}\t${line}`).join('\n');

  const result: ReadResult = { content: numbered, total_lines: totalLines };
  if (offset + limit < totalLines) {
    result.truncated = true;
    result.next_offset = offset + limit;
  }
  return result;
}

// --- Write ---

export function writeFile(filePath: string, content: string): { path: string; bytes: number } {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, { encoding: 'utf-8' });
  return { path: resolved, bytes: Buffer.byteLength(content, 'utf-8') };
}

// --- Edit ---

export function editFile(filePath: string, oldText: string, newText: string): void {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${filePath}`);

  const content = fs.readFileSync(resolved, { encoding: 'utf-8' });
  if (!content.includes(oldText)) throw new Error('old_text not found in file.');

  const count = content.split(oldText).length - 1;
  if (count > 1) throw new Error(`old_text matches ${count} locations. Provide more context to make it unique.`);

  fs.writeFileSync(resolved, content.replace(oldText, newText), { encoding: 'utf-8' });
}

// --- List directory ---

export function listDirectory(dirPath: string, includeHidden = false): ListEntry[] {
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved)) throw new Error(`Directory not found: ${dirPath}`);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${dirPath}`);

  const dirEntries = fs.readdirSync(resolved, { withFileTypes: true });
  return dirEntries
    .filter((e) => includeHidden || !e.name.startsWith('.'))
    .map((entry) => {
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
        type: (entry.isDirectory() ? 'directory' : 'file') as 'file' | 'directory',
        size,
        modified,
        extension: entry.isFile() ? path.extname(entry.name) : '',
      };
    })
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

// --- Recursive file/folder name search ---

export interface NameMatch {
  path: string;
  name: string;
  type: 'file' | 'directory';
}

export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  glob?: string;
}

export async function searchNames(
  query: string,
  dirPath: string,
  options: SearchOptions = {},
  maxResults = 50,
  timeLimitMs = 2000,
): Promise<NameMatch[]> {
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return [];

  const { caseSensitive = false, wholeWord = false } = options;
  const results: NameMatch[] = [];
  const deadline = Date.now() + timeLimitMs;

  function matches(name: string): boolean {
    const a = caseSensitive ? name : name.toLowerCase();
    const b = caseSensitive ? query : query.toLowerCase();
    if (wholeWord) return a === b;
    return a.includes(b);
  }

  async function walk(dir: string, depth: number) {
    if (results.length >= maxResults || depth > 8 || Date.now() > deadline) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (results.length >= maxResults || Date.now() > deadline) return;
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);

      if (matches(entry.name)) {
        results.push({
          path: fullPath,
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
        });
      }

      if (entry.isDirectory()) {
        // Yield to event loop periodically to avoid blocking UI
        if (results.length % 10 === 0) await new Promise((r) => setImmediate(r));
        await walk(fullPath, depth + 1);
      }
    }
  }

  await walk(resolved, 0);
  return results;
}

// --- Content search (ripgrep, streaming) ---

function parseLine(line: string): SearchMatch | null {
  let start = 0;
  if (/^[A-Za-z]:/.test(line)) start = 2;
  const firstColon = line.indexOf(':', start);
  const secondColon = line.indexOf(':', firstColon + 1);
  if (firstColon === -1 || secondColon === -1) return null;
  return {
    path: line.substring(0, firstColon),
    line: parseInt(line.substring(firstColon + 1, secondColon), 10),
    snippet: line.substring(secondColon + 1).trim().substring(0, 200),
  };
}

/**
 * Stream content search results. Calls `onBatch` with new matches as they
 * arrive from ripgrep. Returns a handle to cancel the search.
 */
export function searchStreaming(
  query: string,
  dirPath: string,
  options: SearchOptions = {},
  onBatch: (matches: SearchMatch[]) => void,
  onDone: (error?: string) => void,
  maxResults = 500,
): { cancel: () => void } {
  const { caseSensitive = false, wholeWord = false, glob } = options;
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    onDone(`Directory not found: ${dirPath}`);
    return { cancel: () => {} };
  }

  const parts = [shellEscape(rgPath), '--line-number', '--no-heading', '-F'];
  if (!caseSensitive) parts.push('-i');
  if (wholeWord) parts.push('-w');
  if (glob) parts.push('--glob', shellEscape(glob));
  parts.push('--', shellEscape(query), shellEscape(resolved));

  const cmd = parts.join(' ');
  const proc = exec(cmd, { maxBuffer: MAX_OUTPUT_BYTES * 10 });

  let totalFound = 0;
  let buffer = '';
  let stderrBuf = '';
  let killed = false;

  proc.stderr?.on('data', (chunk: string | Buffer) => {
    stderrBuf += chunk.toString();
  });

  proc.stdout?.on('data', (chunk: string | Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    const batch: SearchMatch[] = [];
    for (const line of lines) {
      if (!line || totalFound >= maxResults) continue;
      const match = parseLine(line);
      if (match) {
        batch.push(match);
        totalFound++;
      }
    }
    if (batch.length > 0) onBatch(batch);
    if (totalFound >= maxResults && !killed) {
      killed = true;
      proc.kill();
    }
  });

  proc.on('close', (code) => {
    if (buffer) {
      const match = parseLine(buffer);
      if (match && totalFound < maxResults) onBatch([match]);
    }
    onDone(code && code !== 0 && code !== 1 && !killed ? stderrBuf.trim() || `rg exited with code ${code}` : undefined);
  });

  proc.on('error', (err) => {
    onDone(err.message);
  });

  return {
    cancel: () => {
      killed = true;
      try { proc.kill(); } catch {}
    },
  };
}

/** Promise-based content search (for host tools / agent use). */
export function search(
  query: string,
  dirPath: string,
  options: SearchOptions = {},
  maxResults = 200,
): Promise<{ matches: SearchMatch[]; error?: string }> {
  return new Promise((resolve) => {
    const all: SearchMatch[] = [];
    searchStreaming(query, dirPath, options,
      (batch) => all.push(...batch),
      (error) => resolve({ matches: all, error }),
      maxResults,
    );
  });
}

// --- Bash ---

export interface BashResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

export function bash(
  command: string,
  workdir?: string,
  timeout = 60,
): Promise<BashResult> {
  const timeoutMs = Math.max(1, Math.min(timeout, 300)) * 1000;
  return new Promise((resolve) => {
    exec(
      command,
      { cwd: workdir, maxBuffer: MAX_OUTPUT_BYTES, timeout: timeoutMs },
      (error, stdout, stderr) => {
        const timedOut = error && 'killed' in error && error.killed === true;
        resolve({
          exit_code: error ? (error as any).code ?? 1 : 0,
          stdout: stdout.substring(0, MAX_OUTPUT_BYTES),
          stderr: stderr.substring(0, MAX_OUTPUT_BYTES),
          timed_out: timedOut || false,
        });
      },
    );
  });
}
