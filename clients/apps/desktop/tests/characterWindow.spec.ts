/**
 * The character window, end to end (#237).
 *
 * Two things had quietly gone wrong: nothing in the UI opened the window since
 * the layout rewrite, and — once the asset routes became bearer-only (#88) —
 * the window would have had no token to send if it had opened. The unit tests
 * pin the push and the retry against fakes; this pins that a real second
 * renderer, started from the real button, fetches a persona's art with the
 * session's token, that a refused token is refreshed through the main window
 * and retried, and that signing out takes it down.
 */

import { test, expect } from './fixtures';
import { ONE_POSE_CHARACTER } from './mock/server';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

async function login(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  const composer = page.getByPlaceholder('Type your message...');
  await expect(composer).toBeVisible({ timeout: 15_000 });
  return composer;
}

/** Open the window from the real button and give it ears: the fixtures listen to the first window only. */
async function openCharacterWindow(page: Page, electronApp: ElectronApplication) {
  const [characterPage] = await Promise.all([
    electronApp.waitForEvent('window'),
    page.getByRole('button', { name: 'Show character window' }).click(),
  ]);
  characterPage.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning' || process.env.RENDERER_DEBUG) {
      console.log(`[character ${msg.type()}]`, msg.text());
    }
  });
  characterPage.on('pageerror', (err) => console.log('[character pageerror]', err.message));
  await expect(page.getByRole('button', { name: 'Hide character window' })).toBeVisible();
  return characterPage;
}

test.describe('character window', () => {
  test('opens from the chat header, fetches its art with the session token, and closes on logout', async ({
    page,
    electronApp,
    mock,
    appPaths,
  }) => {
    mock.setCharacterConfig(1, ONE_POSE_CHARACTER);
    const composer = await login(page);

    // The keychain check forks on the host, as credentials.spec.ts does. The
    // login form's "Remember me" is on by default, so on a host with a keychain
    // the pair is written at login; the window must leave that file exactly as
    // it found it, since a window-side `setToken` would rewrite it with a null
    // refresh token. Without a keychain nothing is ever written, and the only
    // thing to assert is that the window did not make a file appear.
    const secure = await page.evaluate(() =>
      (window as any).electron.credentials.isSecure() as Promise<boolean>,
    );
    const credentialsFile = path.join(appPaths.userDataDir, 'credentials.json');
    if (secure) await expect.poll(() => fs.existsSync(credentialsFile)).toBe(true);
    const credentialsBefore = secure ? fs.readFileSync(credentialsFile, 'utf-8') : null;

    const characterPage = await openCharacterWindow(page, electronApp);

    // A persona is pushed to the window once it has spoken in the
    // conversation; its base image is the fetch under test.
    const assetRequest = characterPage.waitForRequest((request) =>
      request.url().includes('/character-assets/1/p1/base'),
    );
    await composer.fill('Hello world');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Hello from mock backend.')).toBeVisible({ timeout: 15_000 });

    const request = await assetRequest;
    expect(request.headers()['authorization']).toBe('Bearer test-access-token');
    expect((await request.response())?.status()).toBe(200);
    expect(mock.lastCharacterAssetRequest).toEqual({
      path: '/character-assets/1/p1/base',
      authorization: 'Bearer test-access-token',
    });
    await expect(characterPage.getByText('Kurisu')).toBeVisible();

    if (secure) {
      expect(fs.readFileSync(credentialsFile, 'utf-8')).toBe(credentialsBefore);
    } else {
      expect(fs.existsSync(credentialsFile)).toBe(false);
    }

    await Promise.all([
      characterPage.waitForEvent('close'),
      page.getByRole('button', { name: 'Logout' }).click(),
    ]);
    await expect(page.getByRole('button', { name: 'Login' })).toBeVisible({ timeout: 15_000 });
  });

  test('a refused token is refreshed through the main window and the fetch retried', async ({
    page,
    electronApp,
    mock,
  }) => {
    mock.setCharacterConfig(1, ONE_POSE_CHARACTER);
    const composer = await login(page);

    // The login's access token ages out before the window ever uses it. The
    // window holds no refresh token, so the only way to a 200 is the round
    // trip: 401 in the window → `character:session-request` → the main window
    // refreshes and pushes → the window retries with the new bearer.
    mock.expireAccessToken();

    const characterPage = await openCharacterWindow(page, electronApp);

    const retried = characterPage.waitForRequest((request) =>
      request.url().includes('/character-assets/1/p1/base') &&
      request.headers()['authorization'] === 'Bearer test-access-token-refreshed',
    );
    await composer.fill('Hello world');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Hello from mock backend.')).toBeVisible({ timeout: 15_000 });

    const request = await retried;
    expect((await request.response())?.status()).toBe(200);
    expect(mock.characterAssetRequests.map((r) => [r.authorization, r.status])).toEqual([
      ['Bearer test-access-token', 401],
      ['Bearer test-access-token-refreshed', 200],
    ]);
    await expect(characterPage.getByText('Kurisu')).toBeVisible();
  });
});
