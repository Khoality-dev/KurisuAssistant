/**
 * The character window, end to end (#237).
 *
 * Two things had quietly gone wrong: nothing in the UI opened the window since
 * the layout rewrite, and — once the asset routes became bearer-only (#88) —
 * the window would have had no token to send if it had opened. The unit tests
 * pin the push and the retry against fakes; this pins that a real second
 * renderer, started from the real button, fetches a persona's art with the
 * session's token, and that signing out takes it down.
 */

import { test, expect } from './fixtures';
import { ONE_POSE_CHARACTER } from './mock/server';
import fs from 'fs';
import path from 'path';

test.describe('character window', () => {
  test('opens from the chat header, fetches its art with the session token, and closes on logout', async ({
    page,
    electronApp,
    mock,
    appPaths,
  }) => {
    mock.setCharacterConfig(1, ONE_POSE_CHARACTER);

    await page.getByLabel('Username').fill('tester');
    await page.getByLabel('Password').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();
    const composer = page.getByPlaceholder('Type your message...');
    await expect(composer).toBeVisible({ timeout: 15_000 });

    // Remember-me is off in this suite, so nothing is in the keychain; the
    // window must get its token pushed, and must leave the keychain as it is.
    const credentialsFile = path.join(appPaths.userDataDir, 'credentials.json');
    const readCredentials = () =>
      fs.existsSync(credentialsFile) ? fs.readFileSync(credentialsFile, 'utf-8') : null;
    const credentialsBefore = readCredentials();

    const [characterPage] = await Promise.all([
      electronApp.waitForEvent('window'),
      page.getByRole('button', { name: 'Show character window' }).click(),
    ]);
    // The fixtures listen to the first window only; this one needs its own ears.
    characterPage.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning' || process.env.RENDERER_DEBUG) {
        console.log(`[character ${msg.type()}]`, msg.text());
      }
    });
    characterPage.on('pageerror', (err) => console.log('[character pageerror]', err.message));
    await expect(page.getByRole('button', { name: 'Hide character window' })).toBeVisible();

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

    // The token reached the window in memory only.
    expect(readCredentials()).toBe(credentialsBefore);

    await Promise.all([
      characterPage.waitForEvent('close'),
      page.getByRole('button', { name: 'Logout' }).click(),
    ]);
    await expect(page.getByRole('button', { name: 'Login' })).toBeVisible({ timeout: 15_000 });
  });
});
