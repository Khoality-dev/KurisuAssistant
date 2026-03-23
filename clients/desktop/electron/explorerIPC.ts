/**
 * File explorer IPC handlers — unsandboxed filesystem access for the user's
 * file explorer UI. Independent from agent host tools (which are sandboxed
 * to allowed_paths).
 */

import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

export function registerExplorerIPC(): void {
  ipcMain.handle('explorer:list-directory', (_event, dirPath: string) => {
    // Root: return system drives / home directory
    if (!dirPath) {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      const roots: Array<{ name: string; fullPath: string; type: 'directory'; size: number; modified: string | null; extension: string }> = [];
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
      const resolved = path.resolve(filePath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, { encoding: 'utf-8' });
      return { status: 'ok', path: resolved };
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
