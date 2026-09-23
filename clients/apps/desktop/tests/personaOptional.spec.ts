/**
 * The assistant answers without a persona (#302).
 *
 * A persona is a presentation layer the user may add; the assistant chats as
 * itself without one. The desktop used to fill one in on its own — it picked
 * the first persona when none was selected and sent it as an override — so an
 * account with no default still got a persona, and one with none at all could
 * not reach its conversations.
 */

import { test, expect } from './fixtures';
import { Page } from '@playwright/test';
import { MockBackend } from './mock/server';

async function login(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
}

async function send(page: Page, text: string) {
  const input = page.getByPlaceholder('Type your message...');
  await input.fill(text);
  await input.press('Enter');
  await expect(page.getByText('Hello from mock backend.').last()).toBeVisible({ timeout: 10_000 });
}

/** The chat header's "who answers" control; its tooltip is its accessible name. */
const whoAnswers = (page: Page) => page.getByRole('button', { name: /who answers/ });

async function deletePersona(mock: MockBackend, id: number) {
  const res = await fetch(`${mock.url}/personas/${id}`, { method: 'DELETE' });
  expect(res.status).toBe(200);
}

async function openSettings(page: Page) {
  const settingsBtn = page.locator('button').filter({
    has: page.locator('[data-testid="SettingsOutlinedIcon"], [data-testid="SettingsIcon"]'),
  }).first();
  await settingsBtn.click();
  await expect(page.getByText('Account', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
}

test.describe('personas are optional', () => {
  test('an account with no persona chats with the assistant itself', async ({ page, mock }) => {
    await deletePersona(mock, mock.getPersonas()[0].id);

    await login(page);
    await expect(whoAnswers(page)).toContainText('Assistant');
    await send(page, 'hello');

    expect(mock.lastChatRequest.persona_id ?? null).toBeNull();
    const [conversation] = mock.getConversations();
    expect(conversation.persona_id).toBeNull();
  });

  test('with personas but no default, nothing is pinned for the user', async ({ page, mock }) => {
    mock.setAssistantFields({ default_persona_id: null });

    await login(page);
    await expect(whoAnswers(page)).toContainText('Assistant');
    await send(page, 'hello');

    // The client used to pick the first persona and send it as an override.
    expect(mock.lastChatRequest.persona_id ?? null).toBeNull();
    expect(mock.getConversations()[0].persona_id).toBeNull();
  });

  test('the persona sheet offers the assistant, and picking it hands the conversation over', async ({ page, mock }) => {
    await login(page);
    await send(page, 'hello');
    const [conversation] = mock.getConversations();
    expect(conversation.persona_id).toBe(1);
    // The default persona answered, and the header says so before any reload.
    await expect(whoAnswers(page)).toContainText('Kurisu');

    await whoAnswers(page).click();
    await expect(page.getByText('Who should answer?')).toBeVisible();
    await page.getByRole('button', { name: /No persona/ }).click();

    await expect.poll(() => mock.lastConversationPatch).toEqual({ id: conversation.id, body: { persona_id: null } });
    await expect(whoAnswers(page)).toContainText('Assistant');
  });

  test('the conversations page lists the assistant alongside the personas', async ({ page, mock }) => {
    mock.setAssistantFields({ default_persona_id: null });
    await login(page);
    await send(page, 'hello');

    await page.locator('button').filter({
      has: page.locator('[data-testid="ChatBubbleOutlineIcon"], [data-testid="ChatBubbleIcon"]'),
    }).first().click();
    await expect(page.getByRole('heading', { name: 'Conversations' })).toBeVisible({ timeout: 10_000 });

    const assistantRow = page.getByRole('button', { name: /^Assistant/ });
    await expect(assistantRow).toBeVisible();
    await expect(assistantRow).toContainText('Hello from mock backend.');
    await expect(page.getByRole('button', { name: /^Kurisu/ })).toBeVisible();
  });

  test('settings can clear the default and delete the last persona', async ({ page, mock }) => {
    await login(page);
    await openSettings(page);
    await page.getByText('Personas', { exact: true }).first().click();
    await expect(page.getByText('Default', { exact: true })).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Clear default' }).click();
    await expect.poll(() => mock.getAssistant().default_persona_id).toBeNull();
    await expect(page.getByText('Default', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Delete' }).first().click();
    await page.getByRole('button', { name: 'Delete persona' }).click();
    await expect.poll(() => mock.getPersonas().length).toBe(0);
    await expect(page.getByText('No personas yet')).toBeVisible();
    await expect(page.getByText(/the assistant answers as itself/i)).toBeVisible();
  });
});
