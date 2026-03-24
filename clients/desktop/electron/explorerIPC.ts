/**
 * File explorer IPC handlers — unsandboxed filesystem access for the user's
 * file explorer UI. Delegates to shared fsOps for operations that overlap
 * with host tools (read, write, search, list).
 */

import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import * as fsOps from './fsOps';

export function registerExplorerIPC(): void {
  ipcMain.handle('explorer:list-directory', (_event, dirPath: string) => {
    // Root: return system drives / home directory
    if (!dirPath) {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      const roots: fsOps.ListEntry[] = [];
      if (process.platform === 'win32') {
        for (const letter of ['C', 'D', 'E', 'F']) {
          const drive = `${letter}:\\`;
          if (fs.existsSync(drive)) {
            roots.push({ name: `${letter}:`, fullPath: drive, type: 'directory', size: 0, modified: null, extension: '' });
          }
        }
      } else {
        roots.push({ name: 'Home', fullPath: home, type: 'directory', size: 0, modified: null, extension: '' });
        roots.push({ name: '/', fullPath: '/', type: 'directory', size: 0, modified: null, extension: '' });
      }
      return { path: '', entries: roots, isRoot: true };
    }

    try {
      const resolved = path.resolve(dirPath);
      const entries = fsOps.listDirectory(resolved);
      return { path: resolved, entries, isRoot: false };
    } catch (e: any) {
      return { path: dirPath, entries: [], isRoot: false, error: e.message };
    }
  });

  ipcMain.handle('explorer:read-file', async (_event, filePath: string) => {
    try {
      const resolved = path.resolve(filePath);
      const content = fs.readFileSync(resolved, { encoding: 'utf-8' });
      return { content, path: resolved };
    } catch (e: any) {
      return { error: e.message };
    }
  });

  ipcMain.handle('explorer:write-file', async (_event, filePath: string, content: string) => {
    try {
      const result = fsOps.writeFile(filePath, content);
      return { status: 'ok', path: result.path };
    } catch (e: any) {
      return { error: e.message };
    }
  });

  // Binary file detection — read first 512 bytes as raw buffer, check for null bytes
  ipcMain.handle('explorer:is-binary', (_event, filePath: string) => {
    try {
      const resolved = path.resolve(filePath);
      const fd = fs.openSync(resolved, 'r');
      const buf = Buffer.alloc(512);
      const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
      fs.closeSync(fd);
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0) return true;
      }
      return false;
    } catch {
      return false;
    }
  });

  // VS Code detection — check if `code` command is available
  let vsCodeAvailable: boolean | null = null;

  ipcMain.handle('explorer:has-vscode', async () => {
    if (vsCodeAvailable !== null) return vsCodeAvailable;

    return new Promise<boolean>((resolve) => {
      const cmd = process.platform === 'win32' ? 'where code' : 'which code';
      exec(cmd, (err) => {
        vsCodeAvailable = !err;
        resolve(vsCodeAvailable);
      });
    });
  });

  // --- File management operations ---

  ipcMain.handle('explorer:create-file', (_event, filePath: string) => {
    try {
      const resolved = path.resolve(filePath);
      if (fs.existsSync(resolved)) return { error: 'File already exists' };
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, '', { encoding: 'utf-8' });
      return { status: 'ok', path: resolved };
    } catch (e: any) {
      return { error: e.message };
    }
  });

  ipcMain.handle('explorer:create-folder', (_event, dirPath: string) => {
    try {
      const resolved = path.resolve(dirPath);
      if (fs.existsSync(resolved)) return { error: 'Folder already exists' };
      fs.mkdirSync(resolved, { recursive: true });
      return { status: 'ok', path: resolved };
    } catch (e: any) {
      return { error: e.message };
    }
  });

  ipcMain.handle('explorer:rename', (_event, oldPath: string, newPath: string) => {
    try {
      const resolvedOld = path.resolve(oldPath);
      const resolvedNew = path.resolve(newPath);
      if (!fs.existsSync(resolvedOld)) return { error: 'Source not found' };
      if (fs.existsSync(resolvedNew)) return { error: 'Destination already exists' };
      fs.renameSync(resolvedOld, resolvedNew);
      return { status: 'ok', oldPath: resolvedOld, newPath: resolvedNew };
    } catch (e: any) {
      return { error: e.message };
    }
  });

  ipcMain.handle('explorer:delete', (_event, targetPath: string) => {
    try {
      const resolved = path.resolve(targetPath);
      if (!fs.existsSync(resolved)) return { error: 'Not found' };
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        fs.rmSync(resolved, { recursive: true, force: true });
      } else {
        fs.unlinkSync(resolved);
      }
      return { status: 'ok', path: resolved };
    } catch (e: any) {
      return { error: e.message };
    }
  });

  ipcMain.handle('explorer:copy', (_event, srcPath: string, destPath: string) => {
    try {
      const resolvedSrc = path.resolve(srcPath);
      const resolvedDest = path.resolve(destPath);
      if (!fs.existsSync(resolvedSrc)) return { error: 'Source not found' };
      const stat = fs.statSync(resolvedSrc);
      if (stat.isDirectory()) {
        fs.cpSync(resolvedSrc, resolvedDest, { recursive: true });
      } else {
        fs.copyFileSync(resolvedSrc, resolvedDest);
      }
      return { status: 'ok', path: resolvedDest };
    } catch (e: any) {
      return { error: e.message };
    }
  });

  // --- Content search (ripgrep) ---

  ipcMain.handle('explorer:search-names', async (_event, query: string, dirPath: string, options?: { caseSensitive?: boolean; wholeWord?: boolean }) => {
    const { caseSensitive = false, wholeWord = false } = options || {};
    return fsOps.searchNames(query, dirPath, { caseSensitive, wholeWord });
  });

  // Streaming content search — pushes batches to renderer via event
  let activeContentSearch: { cancel: () => void } | null = null;

  ipcMain.handle('explorer:search-content-start', (_event, query: string, dirPath: string, options?: { caseSensitive?: boolean; wholeWord?: boolean; glob?: string }) => {
    // Cancel any previous search
    if (activeContentSearch) { activeContentSearch.cancel(); activeContentSearch = null; }

    const sender = _event.sender;
    const { caseSensitive = false, wholeWord = false, glob } = options || {};

    activeContentSearch = fsOps.searchStreaming(
      query, dirPath, { caseSensitive, wholeWord, glob },
      (batch) => {
        if (!sender.isDestroyed()) sender.send('explorer:search-content-batch', batch);
      },
      (error) => {
        if (!sender.isDestroyed()) sender.send('explorer:search-content-done', error || null);
        activeContentSearch = null;
      },
    );
  });

  ipcMain.handle('explorer:search-content-cancel', () => {
    if (activeContentSearch) { activeContentSearch.cancel(); activeContentSearch = null; }
  });

  ipcMain.handle('explorer:open-in-vscode', async (_event, filePath: string) => {
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      exec(`code "${filePath}"`, (err) => {
        if (err) {
          resolve({ ok: false, error: err.message });
        } else {
          resolve({ ok: true });
        }
      });
    });
  });
}
