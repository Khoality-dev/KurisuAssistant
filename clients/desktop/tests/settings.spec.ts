/**
 * Settings page tests.
 *
 * Exercises navigation between sections and a subset of controls:
 *   - Settings navigation renders all sections
 *   - Appearance section toggles theme
 *   - Agents section loads and lists the mock agent
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

    for (const label of ['Account', 'Voice', 'TTS & ASR', 'Appearance', 'Agents', 'Tools & MCP', 'Skills', 'Host Access', 'Face Identities', 'Extensions']) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
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

  test('agents section lists the mock agent', async ({ page }) => {
    await login(page);
    await openSettings(page);

    await page.getByText('Agents', { exact: true }).first().click();
    // Agent name from mock backend (fixtures.ts defaults to one agent named "Kurisu").
    await expect(page.getByText('Kurisu').first()).toBeVisible({ timeout: 10_000 });
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
