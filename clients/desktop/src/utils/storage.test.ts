/**
 * Token storage (#91).
 *
 * The property under test is negative and easy to lose: **no token is ever
 * written to localStorage**. In Electron that is an unencrypted LevelDB any
 * process running as the user can read, and the refresh token is 30 days of
 * account access.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { storage } from './storage';

const ACCESS = 'access-token-value';
const REFRESH = 'refresh-token-value';

/** A stand-in for the main process's keychain-backed store. */
function fakeBridge(options: { secure?: boolean } = {}) {
  const secure = options.secure ?? true;
  const held: { accessToken: string | null; refreshToken: string | null } = {
    accessToken: null,
    refreshToken: null,
  };
  return {
    held,
    writes: 0,
    isSecure: vi.fn(async () => secure),
    read: vi.fn(async () => ({ ...held })),
    write: vi.fn(async (credentials: { accessToken: string | null; refreshToken: string | null }) => {
      if (!secure) return false;
      held.accessToken = credentials.accessToken;
      held.refreshToken = credentials.refreshToken;
      return true;
    }),
    clear: vi.fn(async () => {
      held.accessToken = null;
      held.refreshToken = null;
    }),
  };
}

function install(bridge: ReturnType<typeof fakeBridge> | undefined) {
  (window as any).electron = bridge ? { credentials: bridge } : undefined;
  return bridge;
}

/** Let the fire-and-forget persist calls settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  localStorage.clear();
  install(fakeBridge());
  await storage.loadPersistedTokens();
  storage.clearTokens();
});

describe('token storage', () => {
  it('keeps tokens out of localStorage entirely', async () => {
    storage.setRememberMe(true);
    storage.setToken(ACCESS);
    storage.setRefreshToken(REFRESH);
    await settle();

    expect(storage.getToken()).toBe(ACCESS);
    expect(storage.getRefreshToken()).toBe(REFRESH);

    const dumped = JSON.stringify(Object.entries(localStorage));
    expect(dumped).not.toContain(ACCESS);
    expect(dumped).not.toContain(REFRESH);
    expect(localStorage.getItem('kurisu_auth_token')).toBeNull();
    expect(localStorage.getItem('kurisu_refresh_token')).toBeNull();
  });

  it('persists through the bridge when remember-me is on', async () => {
    const bridge = install(fakeBridge())!;
    await storage.loadPersistedTokens();
    storage.setRememberMe(true);
    storage.setToken(ACCESS);
    storage.setRefreshToken(REFRESH);
    await settle();

    expect(bridge.held).toEqual({ accessToken: ACCESS, refreshToken: REFRESH });
  });

  it('holds tokens in memory but persists nothing when remember-me is off', async () => {
    const bridge = install(fakeBridge())!;
    await storage.loadPersistedTokens();
    storage.setRememberMe(false);
    storage.setToken(ACCESS);
    storage.setRefreshToken(REFRESH);
    await settle();

    // Memory has them — the authed asset URLs read from here.
    expect(storage.getToken()).toBe(ACCESS);
    expect(bridge.write).not.toHaveBeenCalled();
    expect(bridge.held).toEqual({ accessToken: null, refreshToken: null });
  });

  it('restores what the keychain holds', async () => {
    const bridge = install(fakeBridge())!;
    bridge.held.accessToken = ACCESS;
    bridge.held.refreshToken = REFRESH;

    await storage.loadPersistedTokens();

    expect(storage.getToken()).toBe(ACCESS);
    expect(storage.getRefreshToken()).toBe(REFRESH);
  });

  it('migrates a pair left in localStorage by an older build, then deletes it', async () => {
    const bridge = install(fakeBridge())!;
    localStorage.setItem('kurisu_auth_token', ACCESS);
    localStorage.setItem('kurisu_refresh_token', REFRESH);
    localStorage.setItem('kurisu_remember_me', 'true');

    await storage.loadPersistedTokens();
    await settle();

    expect(storage.getRefreshToken()).toBe(REFRESH);
    expect(bridge.held.refreshToken).toBe(REFRESH);
    expect(localStorage.getItem('kurisu_auth_token')).toBeNull();
    expect(localStorage.getItem('kurisu_refresh_token')).toBeNull();
  });

  it('deletes the old plaintext pair even with no keychain to move it to', async () => {
    install(fakeBridge({ secure: false }))!;
    localStorage.setItem('kurisu_auth_token', ACCESS);
    localStorage.setItem('kurisu_refresh_token', REFRESH);

    await storage.loadPersistedTokens();

    expect(localStorage.getItem('kurisu_auth_token')).toBeNull();
    expect(localStorage.getItem('kurisu_refresh_token')).toBeNull();
    expect(storage.isTokenStorageSecure()).toBe(false);
  });

  it('clears both tokens from memory and from the keychain', async () => {
    const bridge = install(fakeBridge())!;
    await storage.loadPersistedTokens();
    storage.setRememberMe(true);
    storage.setToken(ACCESS);
    storage.setRefreshToken(REFRESH);
    await settle();

    storage.clearTokens();
    await settle();

    expect(storage.getToken()).toBeNull();
    expect(storage.getRefreshToken()).toBeNull();
    expect(bridge.held).toEqual({ accessToken: null, refreshToken: null });
  });

  it('works with no Electron bridge at all, keeping tokens in memory only', async () => {
    install(undefined);
    await storage.loadPersistedTokens();
    storage.setRememberMe(true);
    storage.setToken(ACCESS);

    expect(storage.getToken()).toBe(ACCESS);
    expect(storage.isTokenStorageSecure()).toBe(false);
    expect(localStorage.getItem('kurisu_auth_token')).toBeNull();
  });
});
