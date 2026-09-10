/**
 * A service the server cannot reach must read as an outage, not as an empty
 * or invented list (#151).
 *
 *   - `/tts/models` answering 502 leaves the TTS picker empty with the
 *     server's reason next to it, instead of three made-up models
 *   - `/models` answering 502 puts the server's reason in the header's model
 *     menu — the only model picker since #197 — instead of an empty list that
 *     looks like "no models installed"
 */

import { test, expect } from './fixtures';
import { Page } from '@playwright/test';

async function login(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
}

async function openSettings(page: Page) {
  const settingsBtn = page.locator('button').filter({
    has: page.locator('[data-testid="SettingsOutlinedIcon"], [data-testid="SettingsIcon"]'),
  }).first();
  await settingsBtn.click();
  await expect(page.getByText('Account', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
}

test.describe('unreachable services', () => {
  test('a dead speech service shows its reason and offers no invented TTS models', async ({ page, mock }) => {
    mock.setUnreachable('/tts/models');
    await login(page);
    await openSettings(page);
    await page.getByText('TTS & ASR', { exact: true }).first().click();

    await expect(page.getByText('The speech service is unavailable. (reference: mock)')).toBeVisible({ timeout: 10_000 });

    // The picker names no model: the three fabricated ids are gone, and the
    // only entry is "Default (server)" — the choice to send no provider at all
    // (#200), which is not a model and needs no service to exist. (MUI's
    // Select gives the combobox no accessible name, so find it by its form
    // control.)
    const picker = page.locator('.MuiFormControl-root', { hasText: 'TTS Model' }).getByRole('combobox');
    await expect(picker).toHaveText('Default (server)');
    await picker.click();
    const options = page.getByRole('option');
    await expect(options).toHaveCount(1);
    await expect(options.first()).toHaveText('Default (server)');
    await page.keyboard.press('Escape');
  });

  test('an unreachable model host shows the server\'s reason in the model menu', async ({ page, mock }) => {
    mock.setUnreachable('/models');
    await login(page);
    await page.getByRole('button', { name: 'Change model' }).click();

    await expect(page.getByText('The model host (Ollama) is unreachable. (reference: mock)')).toBeVisible({ timeout: 10_000 });
    // And no invented model beside it.
    await expect(page.getByRole('menuitem', { name: 'test-model' })).toHaveCount(0);
  });
});
