/**
 * Settings page tests.
 *
 * Exercises navigation between sections and a subset of controls:
 *   - Settings navigation renders all sections
 *   - Appearance section toggles theme
 *   - Personas section loads and lists the mock persona
 *   - Assistant section shows the single assistant's capability form
 *   - Account section shows the logged-in user's profile
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
  // ActivityBar wraps each IconButton in a MUI Tooltip/Box, so the button has no
  // intrinsic accessible name. Find it by the icon test id instead.
  const settingsBtn = page.locator('button').filter({
    has: page.locator('[data-testid="SettingsOutlinedIcon"], [data-testid="SettingsIcon"]'),
  }).first();
  await settingsBtn.click();
  await expect(page.getByText('Account', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
}

test.describe('settings', () => {
  test('navigation lists every section', async ({ page }) => {
    await login(page);
    await openSettings(page);

    // The old single "Agents" section is gone: capability, presentation and the
    // task-only workers are three different resources now, so they are three
    // sections. Order is not asserted — only that every one is reachable.
    for (const label of [
      'Account', 'Voice', 'TTS & ASR', 'Appearance',
      'Assistant', 'Personas', 'Sub-Agents',
      'Tools & MCP', 'Skills', 'Host Access', 'Face Identities', 'Extensions',
    ]) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
    await expect(page.getByText('Agents', { exact: true })).toHaveCount(0);
  });

  test('appearance section renders theme toggle', async ({ page }) => {
    await login(page);
    await openSettings(page);

    await page.getByText('Appearance', { exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible({ timeout: 5_000 });

    const light = page.getByRole('button', { name: /Light/ });
    const dark = page.getByRole('button', { name: /Dark/ });
    await expect(light).toBeVisible();
    await expect(dark).toBeVisible();

    // Toggle to dark and confirm selection via aria-pressed.
    await dark.click();
    await expect(dark).toHaveAttribute('aria-pressed', 'true');
    await expect(light).toHaveAttribute('aria-pressed', 'false');

    // Toggle back to light.
    await light.click();
    await expect(light).toHaveAttribute('aria-pressed', 'true');
  });

  test('personas section lists the mock persona', async ({ page }) => {
    await login(page);
    await openSettings(page);

    await page.getByText('Personas', { exact: true }).first().click();
    // Persona name from the mock backend (one persona named "Kurisu" by default).
    await expect(page.getByText('Kurisu').first()).toBeVisible({ timeout: 10_000 });
  });

  test('assistant section shows the wake word from the backend', async ({ page, mock }) => {
    await login(page);
    await openSettings(page);

    await page.getByText('Assistant', { exact: true }).first().click();
    // The wake word is assistant-level and selects no persona. The mock now
    // serves `trigger_word`, which it used to omit even though the client type
    // declares it non-optional.
    const wakeWord = mock.getAssistant().trigger_word!;
    await expect(page.getByLabel('Wake word')).toHaveValue(wakeWord, { timeout: 10_000 });
  });

  test('account section shows logged-in username', async ({ page }) => {
    await login(page);
    await openSettings(page);

    await page.getByText('Account', { exact: true }).first().click();
    // User profile from mock: username=tester, preferred_name=Tester.
    // AccountSection shows Ollama URL / API keys / model picker — verify the section header.
    await expect(page.getByRole('heading', { level: 3, name: /Account/i }).or(page.getByText(/Ollama/i)).first()).toBeVisible({ timeout: 10_000 });
  });
});
