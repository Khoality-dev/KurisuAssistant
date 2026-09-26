/**
 * The inline character panel, end to end (#241).
 *
 * The character used to have exactly one surface, a second Electron window, so
 * the browser build had none. The panel sits in the chat column above the
 * messages on every host: the chat header's Face button and `/live-animate`
 * show and hide it, its height and whether it shows are remembered, and on the
 * desktop it pops out into the window and back — never live in both, so the
 * app holds one WebGL stage per persona at a time.
 *
 * SwiftShader, for the one test that draws a VRM: the model is only fetched
 * behind a WebGL 2 probe, and CI has no GPU (#306).
 */

import { test, expect } from './fixtures';
import { ONE_POSE_CHARACTER, VRM_CHARACTER_WITH_MODEL } from './mock/server';
import type { ElectronApplication, Page } from '@playwright/test';

test.use({ electronArgs: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

async function login(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  const composer = page.getByPlaceholder('Type your message...');
  await expect(composer).toBeVisible({ timeout: 15_000 });
  return composer;
}

async function send(page: Page, text: string) {
  await page.getByPlaceholder('Type your message...').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

async function popOut(page: Page, electronApp: ElectronApplication) {
  const [characterPage] = await Promise.all([
    electronApp.waitForEvent('window'),
    page.getByRole('button', { name: 'Pop out character' }).click(),
  ]);
  characterPage.on('pageerror', (err) => console.log('[character pageerror]', err.message));
  return characterPage;
}

test.describe('inline character panel', () => {
  test('the chat header and /live-animate show and hide the character above the messages', async ({ page, mock }) => {
    mock.setCharacterConfig(1, ONE_POSE_CHARACTER);
    const composer = await login(page);
    const panel = page.getByTestId('character-panel');

    // Hidden until asked for.
    await expect(panel).toHaveCount(0);

    await page.getByRole('button', { name: 'Show character' }).click();
    await expect(panel).toBeVisible();
    await expect(composer).toBeInViewport();

    // Above the messages, and the persona's art comes from the server with the
    // session's bearer — the main window's own, no second renderer involved.
    const panelBox = (await panel.boundingBox())!;
    const composerBox = (await composer.boundingBox())!;
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(composerBox.y);
    await send(page, 'Hello world');
    await expect(page.getByText('Hello from mock backend.')).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText('Kurisu')).toBeVisible();
    await expect.poll(() => mock.characterAssetRequests).toContainEqual({
      path: '/character-assets/1/p1/base',
      authorization: 'Bearer test-access-token',
      status: 200,
    });

    await page.getByRole('button', { name: 'Hide character' }).first().click();
    await expect(panel).toHaveCount(0);

    // The slash command is the same toggle.
    await send(page, '/live-animate');
    await expect(panel).toBeVisible();
    await send(page, '/live-animate');
    await expect(panel).toHaveCount(0);
  });

  test('remembers its height and that it is showing', async ({ page }) => {
    await login(page);
    await page.getByRole('button', { name: 'Show character' }).click();
    const panel = page.getByTestId('character-panel');
    await expect(panel).toBeVisible();
    const before = (await panel.boundingBox())!.height;
    // Shorter, not taller: the panel is capped at 60 % of the column, and on a
    // small runner window (windows-latest) a taller drag stops at the cap.
    // 160 px is the panel's floor (CHARACTER_PANEL_MIN_HEIGHT).
    const target = Math.round(Math.max(160, before - 60));

    const handle = (await page.getByTestId('character-panel-resize').boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 - (before - target), { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => Math.round((await panel.boundingBox())!.height)).toBe(target);

    // A fresh renderer: no keychain in a CI container, so it signs in again.
    await page.reload();
    if (await page.getByLabel('Username').isVisible({ timeout: 5_000 }).catch(() => false)) await login(page);
    await expect(panel).toBeVisible({ timeout: 15_000 });
    expect(Math.round((await panel.boundingBox())!.height)).toBe(target);
  });

  test('pops out into its own window and back, and is never live in both', async ({ page, electronApp, mock }) => {
    mock.setCharacterConfig(1, ONE_POSE_CHARACTER);
    await login(page);
    await page.getByRole('button', { name: 'Show character' }).click();
    await send(page, 'Hello world');
    await expect(page.getByText('Hello from mock backend.')).toBeVisible({ timeout: 15_000 });
    const panel = page.getByTestId('character-panel');
    await expect(panel.getByTestId('character-surface')).toBeVisible();

    const characterPage = await popOut(page, electronApp);
    await expect(panel.getByText('Showing in its own window')).toBeVisible();
    await expect(panel.getByTestId('character-surface')).toHaveCount(0);
    await expect(characterPage.getByText('Kurisu')).toBeVisible({ timeout: 15_000 });

    // Pop in: the window goes, the panel draws again.
    await Promise.all([
      characterPage.waitForEvent('close'),
      page.getByRole('button', { name: 'Pop in character' }).click(),
    ]);
    await expect(panel.getByTestId('character-surface')).toBeVisible();
    await expect(panel.getByText('Showing in its own window')).toHaveCount(0);

    // Closing the window itself brings the character back to the panel too.
    const again = await popOut(page, electronApp);
    await again.close();
    await expect(panel.getByTestId('character-surface')).toBeVisible();

    // Hiding while popped out closes the window and leaves the panel hidden.
    const third = await popOut(page, electronApp);
    await Promise.all([
      third.waitForEvent('close'),
      page.getByRole('button', { name: 'Hide character' }).first().click(),
    ]);
    await expect(panel).toHaveCount(0);
  });

  test('draws a VRM persona fetched from the server', async ({ page, mock }) => {
    mock.setCharacterConfig(1, VRM_CHARACTER_WITH_MODEL);
    await login(page);
    await page.getByRole('button', { name: 'Show character' }).click();
    await send(page, 'Hello world');
    await expect(page.getByText('Hello from mock backend.')).toBeVisible({ timeout: 15_000 });

    await expect.poll(() => mock.characterAssetRequests).toContainEqual({
      path: '/character-assets/1/vrm/model',
      authorization: 'Bearer test-access-token',
      status: 200,
    });
    await expect(page.getByTestId('character-panel').getByTestId('character-surface'))
      .toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
  });
});
