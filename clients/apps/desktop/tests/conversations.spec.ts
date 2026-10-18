/**
 * Getting back to a conversation, and leaving one (#312): the Conversations
 * page, `/resume`, `/clear` and `/delete`. Slash commands are the client's own
 * (`@kurisu/state` `commands.ts`) and never reach the server; what they change
 * on it is asserted on the mock.
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

/** A slash command goes out with Send: Enter in the command menu completes it instead. */
async function command(page: Page, text: string) {
  await page.getByPlaceholder('Type your message...').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

async function openConversations(page: Page) {
  await page.locator('button').filter({
    has: page.locator('[data-testid="ChatBubbleOutlineIcon"], [data-testid="ChatBubbleIcon"]'),
  }).first().click();
}

function seedTwo(mock: MockBackend) {
  const older = mock.addConversation({ title: 'Trip plans', agoMinutes: 90, messages: [
    { role: 'user', content: 'Where should we go in May?' },
    { role: 'assistant', content: 'Lisbon is lovely in May.' },
  ] });
  const newer = mock.addConversation({ title: 'Groceries', agoMinutes: 5, messages: [
    { role: 'user', content: 'What do I need for pancakes?' },
    { role: 'assistant', content: 'Flour, eggs and milk.' },
  ] });
  return { older, newer };
}

test.describe('conversations', () => {
  test('signing in opens the latest, and the Conversations page opens an older one', async ({ page, mock }) => {
    seedTwo(mock);
    await login(page);
    await expect(page.getByText('Flour, eggs and milk.')).toBeVisible({ timeout: 10_000 });

    await openConversations(page);
    const list = page.getByRole('list').filter({ has: page.getByRole('listitem').filter({ hasText: 'Trip plans' }) });
    await list.getByRole('listitem').filter({ hasText: 'Trip plans' }).click();
    // The list previews each conversation's last message, so the chat's copy is the one outside it.
    const inChat = (text: string) => page.locator('p:not(li p)', { hasText: text });
    await expect(inChat('Lisbon is lovely in May.')).toBeVisible({ timeout: 10_000 });
    await expect(inChat('Flour, eggs and milk.')).toHaveCount(0);

    // A message sent now goes into that conversation, not a new one.
    await page.getByPlaceholder('Type your message...').fill('And in June?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Hello from mock backend.').first()).toBeVisible({ timeout: 10_000 });
    expect(mock.lastChatRequest.conversation_id).toBe(mock.getConversations().find((c) => c.title === 'Trip plans')!.id);
    expect(mock.getConversations()).toHaveLength(2);
  });

  test('/resume lists every conversation, and picking one opens it', async ({ page, mock }) => {
    seedTwo(mock);
    await login(page);
    await expect(page.getByText('Flour, eggs and milk.')).toBeVisible({ timeout: 10_000 });

    await command(page, '/resume');
    await expect(page.getByText('Resume Conversation')).toBeVisible();
    await expect(page.getByRole('button', { name: /Groceries/ })).toBeVisible();
    await page.getByRole('button', { name: /Trip plans/ }).click();

    await expect(page.getByText('Resume Conversation')).toHaveCount(0);
    await expect(page.getByText('Lisbon is lovely in May.')).toBeVisible({ timeout: 10_000 });
  });

  test('/resume is left with Escape, and the arrow keys and Enter pick from it', async ({ page, mock }) => {
    seedTwo(mock);
    await login(page);
    await expect(page.getByText('Flour, eggs and milk.')).toBeVisible({ timeout: 10_000 });

    await command(page, '/resume');
    await expect(page.getByText('Resume Conversation')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText('Resume Conversation')).toHaveCount(0);
    await expect(page.getByText('Flour, eggs and milk.')).toBeVisible();

    await command(page, '/resume');
    await expect(page.getByRole('button', { name: /Trip plans/ })).toBeVisible();
    // Newest first: Groceries, then Trip plans.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Lisbon is lovely in May.')).toBeVisible({ timeout: 10_000 });
  });

  test('/clear starts an empty conversation and keeps the old one', async ({ page, mock }) => {
    seedTwo(mock);
    await login(page);
    await expect(page.getByText('Flour, eggs and milk.')).toBeVisible({ timeout: 10_000 });

    await command(page, '/clear');
    await expect(page.getByText('Started a new conversation')).toBeVisible();
    await expect(page.getByText('Flour, eggs and milk.')).toHaveCount(0);

    await page.getByPlaceholder('Type your message...').fill('A fresh start');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Hello from mock backend.').first()).toBeVisible({ timeout: 10_000 });
    expect(mock.lastChatRequest.conversation_id).toBeNull();
    expect(mock.getConversations().map((c) => c.title).sort()).toEqual(['A fresh start', 'Groceries', 'Trip plans']);
  });

  test('/delete removes the open conversation from the server and leaves an empty chat', async ({ page, mock }) => {
    const { newer, older } = seedTwo(mock);
    await login(page);
    await expect(page.getByText('Flour, eggs and milk.')).toBeVisible({ timeout: 10_000 });

    await command(page, '/delete');
    await expect(page.getByText('Conversation deleted')).toBeVisible();
    await expect(page.getByText('Flour, eggs and milk.')).toHaveCount(0);
    await expect.poll(() => mock.getConversations().map((c) => c.id)).toEqual([older]);
    expect(mock.getConversation(newer)).toBeUndefined();

    await openConversations(page);
    await expect(page.getByRole('listitem').filter({ hasText: 'Groceries' })).toHaveCount(0);
    await expect(page.getByRole('listitem').filter({ hasText: 'Trip plans' })).toBeVisible();
  });

  test('/delete with no conversation open deletes nothing', async ({ page, mock }) => {
    seedTwo(mock);
    await login(page);
    await expect(page.getByText('Flour, eggs and milk.')).toBeVisible({ timeout: 10_000 });
    await command(page, '/clear');
    await expect(page.getByText('Flour, eggs and milk.')).toHaveCount(0);

    await command(page, '/delete');
    await expect(page.getByText('No active conversation')).toBeVisible();
    expect(mock.getConversations()).toHaveLength(2);
  });
});
