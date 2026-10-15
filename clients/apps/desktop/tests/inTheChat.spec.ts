/**
 * The persona in use, marked the same way everywhere (#348), as section 2 of
 * the Claude Design mockup "Kurisu - Voice Mode v1" draws it: one "In use" chip
 * on the persona's card, on its row in the chat header's picker, and on an
 * Assistant row when no persona is chosen. It is the account's, so it applies
 * to every conversation at once (#354).
 */
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

async function login(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
}

async function openPersonasSettings(page: Page) {
  await page.locator('button').filter({
    has: page.locator('[data-testid="SettingsOutlinedIcon"], [data-testid="SettingsIcon"]'),
  }).first().click();
  await page.getByText('Personas', { exact: true }).first().click();
  await expect(personasPage(page)).toBeVisible({ timeout: 10_000 });
}

/** Settings → Personas, by the line that opens it. */
const personasPage = (page: Page) => page.getByText('How your assistant sounds', { exact: false });

const whoAnswers = (page: Page) => page.getByRole('button', { name: /Persona in use/ });
/** A persona's card, or the Assistant row, by name. */
const entry = (page: Page, name: string) => page.getByRole('group', { name, exact: true });

test.describe('the persona in use', () => {
  test('Settings → Personas: the persona in use wears the chip; the assistant has its own row', async ({ page, mock }) => {
    mock.addPersona({ name: 'Coach', description: 'Warm, direct, keeps you moving.' });
    await login(page);
    await openPersonasSettings(page);

    const kurisu = entry(page, 'Kurisu');
    await expect(kurisu).toHaveAttribute('aria-current', 'true');
    await expect(kurisu.getByText('In use', { exact: true })).toBeVisible();
    await expect(kurisu.getByRole('button', { name: 'Use the assistant' })).toBeVisible();
    await expect(entry(page, 'Coach').getByRole('button', { name: 'Talk to' })).toBeVisible();

    const assistant = entry(page, 'Assistant');
    await expect(assistant).toContainText('No persona. The assistant answers as itself.');
    await expect(assistant).not.toHaveAttribute('aria-current', 'true');

    // The dashed row puts the chat on the assistant; then it wears the chip.
    await assistant.click();
    await expect.poll(() => mock.getAssistant().selected_persona_id).toBeNull();
    await expect(assistant).toHaveAttribute('aria-current', 'true');
    await expect(assistant.getByText('In use', { exact: true })).toBeVisible();
    await expect(kurisu.getByText('In use', { exact: true })).toHaveCount(0);
    await expect(kurisu.getByRole('button', { name: 'Talk to' })).toBeVisible();
  });

  test('the header picker marks the same row, says the choice is the account\'s, and leads to Personas', async ({ page }) => {
    await login(page);
    await whoAnswers(page).click();

    await expect(page.getByText('Persona in use', { exact: true }).last()).toBeVisible();
    await expect(page.getByText('Saved to your account: every conversation, on every device, answers as it. Press Esc to cancel.')).toBeVisible();
    const current = page.locator('[aria-current="true"]');
    await expect(current).toHaveCount(1);
    await expect(current).toContainText('Kurisu');
    await expect(current).toContainText('In use');

    await page.getByRole('button', { name: 'Manage personas' }).click();
    await expect(personasPage(page)).toBeVisible({ timeout: 10_000 });
  });

  test('a persona without a picture has the person icon; the assistant keeps its own', async ({ page, mock }) => {
    await login(page);
    await expect(whoAnswers(page).locator('[data-testid="AccountCircleIcon"]')).toBeVisible();
    await expect(whoAnswers(page).locator('[data-testid="SmartToyIcon"]')).toHaveCount(0);

    mock.setAssistantFields({ selected_persona_id: null });
    await page.reload();
    if (await page.getByLabel('Username').isVisible({ timeout: 5_000 }).catch(() => false)) await login(page);
    await expect(whoAnswers(page)).toContainText('Assistant', { timeout: 10_000 });
    await expect(whoAnswers(page).locator('[data-testid="SmartToyIcon"]')).toBeVisible();
  });
});
