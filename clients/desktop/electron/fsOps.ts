/**
 * Shared filesystem operations used by both host tools (agent-facing, gated)
 * and explorer IPC (user-facing, direct). Pure functions — no approval logic.
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

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

// --- Search (ripgrep) ---

export function search(
  query: string,
  dirPath: string,
  glob?: string,
  maxResults = 200,
): Promise<{ matches: SearchMatch[]; error?: string }> {
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return Promise.resolve({ matches: [], error: `Directory not found: ${dirPath}` });
  }

  const rgArgs = ['--line-number', '--no-heading', '--max-count', String(maxResults)];
  if (glob) rgArgs.push('--glob', glob);
  rgArgs.push('--', query, resolved);

  const cmd = ['rg', ...rgArgs.map((a) => `"${a.replace(/"/g, '\\"')}"`)]  .join(' ');

  return new Promise((resolve) => {
    exec(cmd, { maxBuffer: MAX_OUTPUT_BYTES, timeout: 30000 }, (error, stdout, stderr) => {
      if (error && !stdout) {
        if (error.code === 1) {
          resolve({ matches: [] });
          return;
        }
        resolve({ matches: [], error: stderr || error.message });
        return;
      }

      const lines = stdout.trim().split('\n').filter(Boolean).slice(0, maxResults);
      const matches: SearchMatch[] = [];
      for (const line of lines) {
        // rg output: path:line:content
        // On Windows, skip drive letter colon (e.g. "D:\foo\bar.txt:5:hello")
        let start = 0;
        if (/^[A-Za-z]:/.test(line)) start = 2;
        const firstColon = line.indexOf(':', start);
        const secondColon = line.indexOf(':', firstColon + 1);
        if (firstColon === -1 || secondColon === -1) continue;
        matches.push({
          path: line.substring(0, firstColon),
          line: parseInt(line.substring(firstColon + 1, secondColon), 10),
          snippet: line.substring(secondColon + 1).trim().substring(0, 200),
        });
      }
      resolve({ matches });
    });
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
