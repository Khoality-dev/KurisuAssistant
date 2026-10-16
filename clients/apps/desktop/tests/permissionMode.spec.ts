/**
 * The permission mode beside the chat input (#360): one setting for the
 * account, shown on the composer and changed from it.
 */

import { test, expect } from './fixtures';
import { Page } from '@playwright/test';

async function login(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
}

test.describe('the permission mode', () => {
  test('starts on Always ask and changes from beside the input', async ({ page, mock }) => {
    await login(page);

    const chip = page.getByRole('button', { name: /Permission mode: Always ask/ });
    await expect(chip).toBeVisible();
    await chip.click();

    await expect(page.getByRole('menuitemradio', { name: /Auto/ })).toHaveAttribute('aria-disabled', 'true');
    await page.getByRole('menuitemradio', { name: /Read only/ }).click();

    await expect(page.getByRole('button', { name: /Permission mode: Read only/ })).toBeVisible();
    await expect.poll(() => mock.getAssistant().permission_mode).toBe('read_only');
  });

  test('shows a mode changed on another device when the menu opens', async ({ page, mock }) => {
    await login(page);
    await expect(page.getByRole('button', { name: /Permission mode: Always ask/ })).toBeVisible();

    mock.setAssistantFields({ permission_mode: 'full' });
    await page.getByRole('button', { name: /Permission mode/ }).click();
    await page.keyboard.press('Escape');

    await expect(page.getByRole('button', { name: /Permission mode: Full access/ })).toBeVisible();
  });
});
