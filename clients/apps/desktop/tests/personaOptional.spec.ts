/**
 * Personas are optional, and one is in use for the whole account (#302, #354).
 *
 * A persona is a presentation layer the user may add; the assistant chats as
 * itself without one. One persona, or none, is in use for the whole account:
 * the server answers every turn, in every conversation, as it. So the client
 * never names a persona on a chat request, a switch is a `PATCH /assistant`
 * that leaves the open conversation open, and the Conversations page lists
 * conversations, not personas.
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

/** The chat header's persona control; its tooltip is its accessible name. */
const personaInUse = (page: Page) => page.getByRole('button', { name: /Persona in use/ });

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

async function openConversations(page: Page) {
  await page.locator('button').filter({
    has: page.locator('[data-testid="ChatBubbleOutlineIcon"], [data-testid="ChatBubbleIcon"]'),
  }).first().click();
  await expect(page.getByRole('heading', { name: 'Conversations' })).toBeVisible({ timeout: 10_000 });
}

/** Who spoke the last assistant message the mock stored in a conversation. */
function lastSpeaker(mock: MockBackend, conversationId: number): number | null {
  const messages = mock.getConversation(conversationId)!.messages.filter((m) => m.role === 'assistant');
  return messages[messages.length - 1].persona_id;
}

test.describe('personas are optional', () => {
  test('an account with no persona chats with the assistant itself', async ({ page, mock }) => {
    await deletePersona(mock, mock.getPersonas()[0].id);

    await login(page);
    await expect(personaInUse(page)).toContainText('Assistant');
    await send(page, 'hello');

    expect(mock.lastChatRequest).not.toHaveProperty('persona_id');
    expect(lastSpeaker(mock, mock.getConversations()[0].id)).toBeNull();
  });

  test('with personas but none in use, the assistant answers', async ({ page, mock }) => {
    mock.setAssistantFields({ selected_persona_id: null });

    await login(page);
    await expect(personaInUse(page)).toContainText('Assistant');
    await send(page, 'hello');

    expect(mock.lastChatRequest).not.toHaveProperty('persona_id');
    expect(lastSpeaker(mock, mock.getConversations()[0].id)).toBeNull();
  });

  test('settings can take the chat off a persona and delete the last one', async ({ page, mock }) => {
    await login(page);
    await openSettings(page);
    await page.getByText('Personas', { exact: true }).first().click();
    await expect(page.getByText('In use', { exact: true })).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Use the assistant' }).click();
    await expect.poll(() => mock.getAssistant().selected_persona_id).toBeNull();
    // The chip moves to the Assistant row (#348).
    await expect(page.getByRole('group', { name: 'Kurisu', exact: true }).getByText('In use', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Assistant', exact: true })).toHaveAttribute('aria-current', 'true');

    await page.getByRole('button', { name: 'Delete' }).first().click();
    await page.getByRole('button', { name: 'Delete persona' }).click();
    await expect.poll(() => mock.getPersonas().length).toBe(0);
    await expect(page.getByText('No personas yet')).toBeVisible();
    await expect(page.getByText(/the assistant answers as itself/i)).toBeVisible();
  });
});

test.describe('one persona in use for the whole account', () => {
  test('the server answers as the persona in use; the request names none', async ({ page, mock }) => {
    await login(page);
    await expect(personaInUse(page)).toContainText('Kurisu');
    await send(page, 'hello');

    expect(mock.lastChatRequest).not.toHaveProperty('persona_id');
    expect(lastSpeaker(mock, mock.getConversations()[0].id)).toBe(1);
  });

  test('a switch from the header is saved to the account, and the open conversation carries on', async ({ page, mock }) => {
    await login(page);
    await send(page, 'hello');
    const [conversation] = mock.getConversations();

    await personaInUse(page).click();
    await expect(page.getByText('Persona in use', { exact: true }).last()).toBeVisible();
    await page.getByRole('button', { name: /No persona/ }).click();

    await expect.poll(() => mock.getAssistant().selected_persona_id).toBeNull();
    await expect(personaInUse(page)).toContainText('Assistant');
    expect(mock.lastConversationPatch).toBeNull();
    // Still the same conversation: what was said is on screen, and the next
    // turn lands in it, answered by the assistant.
    await expect(page.getByText('hello', { exact: true })).toBeVisible();
    const input = page.getByPlaceholder('Type your message...');
    await input.fill('and now?');
    await input.press('Enter');
    await expect.poll(() => mock.getConversation(conversation.id)!.messages.length).toBe(4);
    expect(mock.getConversations()).toHaveLength(1);
    expect(lastSpeaker(mock, conversation.id)).toBeNull();
  });

  test('the persona in use is kept on the server, so signing in again opens on it (#334)', async ({ page, mock }) => {
    mock.setAssistantFields({ selected_persona_id: null });
    await login(page);
    await expect(personaInUse(page)).toContainText('Assistant');

    await personaInUse(page).click();
    await page.getByRole('button', { name: /^Kurisu/ }).click();
    await expect.poll(() => mock.getAssistant().selected_persona_id).toBe(1);

    // This machine forgets everything but where the server is; the server does not.
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key !== 'kurisu_backend_url') localStorage.removeItem(key);
      }
    });
    await page.reload();
    if (await page.getByLabel('Username').isVisible({ timeout: 5_000 }).catch(() => false)) await login(page);
    await expect(personaInUse(page)).toContainText('Kurisu', { timeout: 10_000 });
  });

  test('a message sent before the persona has loaded is still answered as the persona in use', async ({ page, mock }) => {
    // The server decides who answers, so a send that beats `GET /assistant`
    // has nothing to wait for and nothing to get wrong (#334).
    mock.delayRoute('GET', '/assistant', 1500);
    await login(page);
    await send(page, 'hello');

    expect(mock.lastChatRequest).not.toHaveProperty('persona_id');
    expect(lastSpeaker(mock, mock.getConversations()[0].id)).toBe(1);
  });

  test('the Conversations page lists conversations, newest first, with no persona per row', async ({ page, mock }) => {
    await login(page);
    await send(page, 'first thread');
    // A slash command goes out with the Send button: Enter in the command menu
    // completes the command instead of sending it.
    await page.getByPlaceholder('Type your message...').fill('/clear');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('first thread', { exact: true })).toHaveCount(0);
    await send(page, 'second thread');
    await expect.poll(() => mock.getConversations().length).toBe(2);

    await openConversations(page);
    const rows = page.getByRole('listitem').filter({ hasText: 'thread' });
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('second thread');
    await expect(rows.nth(1)).toContainText('first thread');
    await expect(rows.nth(0)).toContainText('Hello from mock backend.');
    await expect(page.getByRole('button', { name: /^Kurisu/ })).toHaveCount(0);

    // The list stays beside the chat, so each title is on the page once as a
    // row; the open conversation's message makes it twice.
    await rows.nth(1).getByRole('button').first().click();
    await expect(page.getByText('first thread', { exact: true })).toHaveCount(2, { timeout: 10_000 });
    await expect(page.getByText('second thread', { exact: true })).toHaveCount(1);
  });

  test('New chat on the Conversations page starts an empty conversation', async ({ page }) => {
    await login(page);
    await send(page, 'an old thread');
    await openConversations(page);

    await expect(page.getByText('an old thread', { exact: true })).toHaveCount(2);
    await page.getByRole('button', { name: 'New chat' }).click();
    // Only the list row is left: the chat beside it is empty.
    await expect(page.getByText('an old thread', { exact: true })).toHaveCount(1);
    await expect(page.getByRole('listitem').filter({ hasText: 'an old thread' })).toHaveCount(1);
  });
});
