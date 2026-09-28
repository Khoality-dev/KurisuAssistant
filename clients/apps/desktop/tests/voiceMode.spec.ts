/**
 * Voice mode, turned on and off from the chat header (#253).
 *
 * It replaced the "Always listen" setting: the mic listens only in voice mode,
 * where it waits for the wake word. The voice bar stands in for the message
 * box while it is on. Chromium's fake device stands in for a microphone here.
 */
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

test.use({ electronArgs: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

async function login(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
}

test.describe('voice mode', () => {
  test('the chat header turns it on: the voice bar waits for the wake word in place of the message box', async ({ page }) => {
    await login(page);

    await page.getByRole('button', { name: 'Start voice mode' }).click();
    await expect(page.getByText('Waiting for the wake word...')).toBeVisible();
    await expect(page.getByPlaceholder('Type your message...')).toHaveCount(0);

    // The voice bar's own button turns it off.
    await page.getByRole('button', { name: 'End voice mode' }).last().click();
    await expect(page.getByPlaceholder('Type your message...')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start voice mode' })).toBeVisible();
  });

  test('the header button turns it off too, and the app remembers it was on', async ({ page }) => {
    await login(page);

    await page.getByRole('button', { name: 'Start voice mode' }).click();
    await expect(page.getByText('Waiting for the wake word...')).toBeVisible();

    await page.reload();
    // Not `login()`: it waits for the message box, which voice mode hides.
    if (await page.getByLabel('Username').isVisible({ timeout: 5_000 }).catch(() => false)) {
      await page.getByLabel('Username').fill('tester');
      await page.getByLabel('Password').fill('password');
      await page.getByRole('button', { name: 'Login' }).click();
    }
    await expect(page.getByText('Waiting for the wake word...')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'End voice mode' }).first().click();
    await expect(page.getByPlaceholder('Type your message...')).toBeVisible();
  });

  test('Settings no longer has "Always listen": voice mode replaced it', async ({ page }) => {
    await login(page);
    await page.locator('button').filter({ has: page.locator('[data-testid="SettingsIcon"], [data-testid="SettingsOutlinedIcon"]') }).first().click();
    await page.getByText('Voice', { exact: true }).first().click();
    await expect(page.getByText('Microphone', { exact: false }).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Always listen')).toHaveCount(0);
  });
});
