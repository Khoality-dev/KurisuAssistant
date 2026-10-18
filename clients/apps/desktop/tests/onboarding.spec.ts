/**
 * Onboarding a new account (#342), which asks only for the model (#376).
 *
 * The first sign-in to an account the server says is owed onboarding opens one
 * screen before the chat: pick a provider, connect it, pick one of its models.
 * Finishing saves that model and nothing else — once it has a model, the
 * assistant can be asked for a persona, a voice or a wake word. Skip keeps
 * nothing. Either way the server records it, so no device asks again. Every
 * assertion that matters is on what the mock stored, not only on the screen.
 */

import { test, expect } from './fixtures';
import { Page } from '@playwright/test';
import { MockBackend } from './mock/server';

async function signIn(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
}

const dialog = (page: Page) => page.getByRole('dialog');

test.describe('onboarding a new account', () => {
  test.beforeEach(({ mock }) => {
    mock.becomeNewAccount();
  });

  test('one screen: connect Ollama, pick its model, and the chat opens on it', async ({ page, mock }) => {
    await signIn(page);
    await expect(dialog(page).getByRole('heading', { name: 'Model' })).toBeVisible({ timeout: 15_000 });
    // The model is the whole of it: no steps after it.
    await expect(page.getByRole('button', { name: 'Next' })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Provider' })).toHaveText('Ollama');
    // No model to start chatting with until a provider lists one.
    await expect(page.getByRole('button', { name: 'Start chatting' })).toBeDisabled();

    await page.getByLabel('Ollama address').fill('http://192.168.1.20:11434');
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByText('Connected · 1 model')).toBeVisible();
    expect(mock.ollamaUrl).toBe('http://192.168.1.20:11434');
    await expect(page.getByRole('combobox', { name: 'Model' })).toHaveText('test-model');

    await page.getByRole('button', { name: 'Start chatting' }).click();
    await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
    expect(mock.getAssistant()).toMatchObject({ model_name: 'test-model', selected_persona_id: null, trigger_word: null });
    expect(mock.getPersonas()).toEqual([]);
    expect(mock.onboarded).toBe(true);
  });

  test('a cloud provider asks for its API key, and Ollama’s address is not shown', async ({ page }) => {
    await signIn(page);
    await expect(dialog(page).getByRole('heading', { name: 'Model' })).toBeVisible({ timeout: 15_000 });

    await page.getByRole('combobox', { name: 'Provider' }).click();
    await page.getByRole('option', { name: 'Google Gemini' }).click();
    await expect(page.getByLabel('API key')).toBeVisible();
    await expect(page.getByLabel('Ollama address')).toHaveCount(0);
  });

  test('Skip keeps nothing, and no device is asked again', async ({ page, mock }) => {
    await signIn(page);
    await expect(dialog(page).getByRole('heading', { name: 'Model' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Skip' }).click();
    await expect(page.getByRole('heading', { name: 'Skip setup?' })).toBeVisible();
    await page.getByRole('dialog', { name: 'Skip setup?' }).getByRole('button', { name: 'Skip' }).click();

    await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
    expect(mock.onboarded).toBe(true);
    expect(mock.getPersonas()).toEqual([]);
    expect(mock.getAssistant()).toMatchObject({ model_name: null, trigger_word: null, selected_persona_id: null });
    // What another device would read on its first sign-in.
    const profile = await (await fetch(`${mock.url}/users/me`)).json();
    expect(profile.onboarding_pending).toBe(false);
  });
});

// The rest of the suite plays accounts that are set up; none of them is asked.
test('an account that is set up never sees it', async ({ page, mock }: { page: Page; mock: MockBackend }) => {
  await signIn(page);
  await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Skip setup?' })).toHaveCount(0);
  expect(mock.onboarded).toBe(true);
});
