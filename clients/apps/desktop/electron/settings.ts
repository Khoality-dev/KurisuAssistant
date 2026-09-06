/**
 * The main process's settings file.
 *
 * One JSON file under `userData`, holding what the Electron side must remember
 * across restarts: host-tool approvals, the MCP bearer token, first-run flags.
 * It was being loaded and saved by three modules with three private copies of
 * the same two functions, which is fine until two of them write in the same
 * tick and the last writer drops the other's keys.
 *
 * Renderer preferences do not belong here — those stay in localStorage.
 */

import { app } from 'electron';
import fs from 'fs';
import path from 'path';

function settingsPath(): string {
  // Resolved per call, not at import time: `app.getPath('userData')` is
  // rewritten during startup (E2E runs point it at a temp dir).
  return path.join(app.getPath('userData'), 'settings.json');
}

export function loadSettings(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
  } catch {
    return {};
  }
}

export function saveSettings(settings: Record<string, any>): void {
  const target = settingsPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(settings, null, 2));
}

/** Read one key. */
export function getSetting<T = unknown>(key: string): T | undefined {
  return loadSettings()[key] as T | undefined;
}

/** Write one key, preserving the rest of the file. */
export function setSetting(key: string, value: unknown): void {
  const settings = loadSettings();
  settings[key] = value;
  saveSettings(settings);
}
