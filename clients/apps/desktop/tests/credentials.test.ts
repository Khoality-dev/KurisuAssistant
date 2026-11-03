// @vitest-environment node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  userData: '',
  decryptString: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => electron.userData },
  ipcMain: { handle: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: vi.fn(),
    decryptString: electron.decryptString,
  },
}));

import { readCredentials } from '../electron/credentials';

describe('credential recovery after the app rename', () => {
  afterEach(() => {
    if (electron.userData) fs.rmSync(electron.userData, { recursive: true, force: true });
    electron.userData = '';
    electron.decryptString.mockReset();
  });

  it('treats ciphertext the renamed Linux keyring cannot decrypt as signed out', () => {
    electron.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-credentials-'));
    fs.writeFileSync(
      path.join(electron.userData, 'credentials.json'),
      JSON.stringify({ access_token: 'b2xk', refresh_token: 'a2V5' }),
    );
    electron.decryptString.mockImplementation(() => {
      throw new Error('keyring entry belongs to the old application name');
    });

    expect(readCredentials()).toEqual({ accessToken: null, refreshToken: null });
  });
});
