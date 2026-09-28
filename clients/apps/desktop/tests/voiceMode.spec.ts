/**
 * Voice mode, turned on and off from the chat header (#253), as the Claude
 * Design mockup "Kurisu - Voice Mode v1" draws it (#345).
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

const voiceBar = (page: Page) => page.getByRole('region', { name: 'Voice mode' });

test.describe('voice mode', () => {
  test('the chat header turns it on: a pill says so, and the voice bar stands in for the message box', async ({ page }) => {
    await login(page);

    await page.getByRole('button', { name: 'Start voice mode' }).click();
    await expect(voiceBar(page)).toBeVisible();
    await expect(page.getByPlaceholder('Type your message...')).toHaveCount(0);
    // The chat column is 400 px wide by default: the narrow pill.
    const pill = page.getByRole('button', { name: 'End voice mode' }).first();
    await expect(pill).toHaveText('On');

    // The voice bar's own labelled button turns it off, and a snackbar says the mic is off.
    await voiceBar(page).getByRole('button', { name: 'End voice mode' }).click();
    await expect(page.getByPlaceholder('Type your message...')).toBeVisible();
    await expect(page.getByText("Voice mode is off. The mic isn't listening.")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start voice mode' })).toBeVisible();
  });

  test('the header pill turns it off too, and the app remembers it was on', async ({ page }) => {
    await login(page);

    await page.getByRole('button', { name: 'Start voice mode' }).click();
    await expect(voiceBar(page)).toBeVisible();

    await page.reload();
    // Not `login()`: it waits for the message box, which voice mode hides.
    if (await page.getByLabel('Username').isVisible({ timeout: 5_000 }).catch(() => false)) {
      await page.getByLabel('Username').fill('tester');
      await page.getByLabel('Password').fill('password');
      await page.getByRole('button', { name: 'Login' }).click();
    }
    await expect(voiceBar(page)).toBeVisible({ timeout: 15_000 });

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
