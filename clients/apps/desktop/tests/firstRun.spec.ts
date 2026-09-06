/**
 * What a brand-new account meets on its very first message.
 *
 * Provisioning cannot pick a model, so `assistants.model_name` starts NULL and
 * the first message has nothing to run on. The server refuses the turn with
 * `NO_MODEL_SELECTED` (see backend/docs/websocket.md), and this client is
 * expected to turn that one code into the screen that fixes it rather than the
 * red toast every other error gets — the failure #149 was filed about.
 *
 * The mock is put in the same state a fresh install is in: no model on the
 * assistant, and the client naming none of its own (it always sends `''`).
 */

import { test, expect } from './fixtures';
import { Page } from '@playwright/test';

async function login(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
}

async function send(page: Page, text: string) {
  await page.getByPlaceholder('Type your message...').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.describe('first run with no model chosen', () => {
  test('the refusal names the setting and opens it, and the message is not lost', async ({ page, mock }) => {
    mock.setAssistantModel(null);

    await login(page);
    await send(page, 'hello there');

    // A prompt, not the red error toast: it says which field is empty and stays
    // put instead of vanishing after six seconds.
    const prompt = page.getByText('No model selected', { exact: true });
    await expect(prompt).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Something went wrong on the server/)).toHaveCount(0);

    // The server rejected the turn before saving anything, so the client hands
    // the text back rather than making the user retype it.
    await expect(page.getByPlaceholder('Type your message...')).toHaveValue('hello there');

    // And the way out is one click, on the prompt itself.
    await page.getByRole('button', { name: 'Choose a model' }).click();
    await expect(page.getByLabel('Wake word')).toBeVisible({ timeout: 10_000 });
  });

  test('once a model is chosen the same message goes through', async ({ page, mock }) => {
    mock.setAssistantModel(null);
    mock.setStream({ chunks: [{ content: 'Answered at last.', role: 'assistant', delayMs: 20 }] });

    await login(page);
    await send(page, 'hello there');
    await expect(page.getByText('No model selected', { exact: true })).toBeVisible({ timeout: 10_000 });

    mock.setAssistantModel('test-model');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(page.getByText('Answered at last.')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('No model selected', { exact: true })).toHaveCount(0);
  });
});
