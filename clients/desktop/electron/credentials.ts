/**
 * Where the session tokens live.
 *
 * They used to sit in `localStorage`, which in Electron is an unencrypted
 * LevelDB under the app's user-data directory — readable by any process running
 * as the user, and the refresh token is 30 days of account access. The Android
 * client had this right already, with EncryptedSharedPreferences.
 *
 * Here they go through `safeStorage`, which is backed by the OS keychain
 * (Keychain on macOS, DPAPI on Windows, libsecret/kwallet on Linux). The
 * ciphertext is written to `credentials.json` in userData, base64-encoded.
 *
 * If the OS has no keychain to offer — a Linux box with no secret service —
 * nothing is written at all. The session still works until the app closes; what
 * is refused is writing a 30-day credential to disk in the clear, which is the
 * thing this file exists to stop. `isSecure` tells the renderer, so "Remember
 * me" can say why it did not stick.
 */

import { app, ipcMain, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';

export interface StoredCredentials {
  accessToken: string | null;
  refreshToken: string | null;
}

const EMPTY: StoredCredentials = { accessToken: null, refreshToken: null };

function credentialsPath(): string {
  // Resolved per call: userData is rewritten during startup (E2E runs point it
  // at a temp directory).
  return path.join(app.getPath('userData'), 'credentials.json');
}

export function isSecureStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function encrypt(value: string | null): string | null {
  if (!value) return null;
  return safeStorage.encryptString(value).toString('base64');
}

function decrypt(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  } catch {
    // Wrong keychain, another machine, a corrupt file: treat as absent rather
    // than wedging startup on it.
    return null;
  }
}

export function readCredentials(): StoredCredentials {
  if (!isSecureStorageAvailable()) return EMPTY;
  try {
    const raw = JSON.parse(fs.readFileSync(credentialsPath(), 'utf-8'));
    return {
      accessToken: decrypt(raw.access_token),
      refreshToken: decrypt(raw.refresh_token),
    };
  } catch {
    return EMPTY;
  }
}

export function writeCredentials(credentials: StoredCredentials): boolean {
  if (!isSecureStorageAvailable()) return false;
  const target = credentialsPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    JSON.stringify(
      {
        access_token: encrypt(credentials.accessToken),
        refresh_token: encrypt(credentials.refreshToken),
      },
      null,
      2,
    ),
    // Belt and braces on top of the encryption: no other user needs to read it.
    { mode: 0o600 },
  );
  return true;
}

export function clearCredentials(): void {
  try {
    fs.rmSync(credentialsPath(), { force: true });
  } catch {
    /* nothing to clear */
  }
}

export function registerCredentialsIPC(): void {
  ipcMain.handle('credentials:is-secure', () => isSecureStorageAvailable());
  ipcMain.handle('credentials:read', () => readCredentials());
  ipcMain.handle('credentials:write', (_event, credentials: StoredCredentials) =>
    writeCredentials({
      accessToken: credentials?.accessToken ?? null,
      refreshToken: credentials?.refreshToken ?? null,
    }),
  );
  ipcMain.handle('credentials:clear', () => clearCredentials());
}
