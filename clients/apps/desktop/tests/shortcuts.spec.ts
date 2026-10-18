/**
 * The keyboard in the chat, and searching it (#312): Enter sends and
 * Shift+Enter breaks the line, the arrows walk back through what I sent, Tab
 * takes a slash command, and Ctrl+F searches the conversation — and only the
 * conversation, when that is where I am.
 */
import { test, expect } from './fixtures';
import { Page } from '@playwright/test';

async function login(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
}

const composer = (page: Page) => page.getByPlaceholder('Type your message...');

test.describe('the keyboard in the chat', () => {
  test('Enter sends, Shift+Enter starts a new line', async ({ page, mock }) => {
    await login(page);
    await composer(page).click();
    await page.keyboard.type('first line');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('second line');
    await expect(composer(page)).toHaveValue('first line\nsecond line');
    await page.keyboard.press('Enter');

    await expect(page.getByText('Hello from mock backend.').first()).toBeVisible({ timeout: 10_000 });
    expect(mock.lastChatRequest.text).toBe('first line\nsecond line');
    await expect(composer(page)).toHaveValue('');
  });

  test('the up and down arrows walk through what I sent, and back to my draft', async ({ page, mock }) => {
    mock.setStream({ chunks: [{ content: 'ok', role: 'assistant', delayMs: 5 }] });
    await login(page);
    for (const text of ['one', 'two']) {
      await composer(page).fill(text);
      await composer(page).press('Enter');
      await expect(page.getByText(text, { exact: true })).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('button[title="Stop"]')).toHaveCount(0, { timeout: 10_000 });
    }

    await composer(page).click();
    await page.keyboard.press('ArrowUp');
    await expect(composer(page)).toHaveValue('two');
    await page.keyboard.press('ArrowUp');
    await expect(composer(page)).toHaveValue('one');
    await page.keyboard.press('ArrowDown');
    await expect(composer(page)).toHaveValue('two');
    await page.keyboard.press('ArrowDown');
    await expect(composer(page)).toHaveValue('');
  });

  test('typing / lists the commands, and Tab takes the one picked', async ({ page }) => {
    await login(page);
    await composer(page).click();
    await page.keyboard.type('/re');
    await expect(page.getByRole('menuitem', { name: /\/resume/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /\/refresh/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /\/clear/ })).toHaveCount(0);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Tab');
    await expect(composer(page)).toHaveValue('/refresh');
    await expect(page.getByRole('menuitem')).toHaveCount(0);
  });
});

test.describe('searching the conversation', () => {
  test('Ctrl+F finds every message that says it, and moves between them', async ({ page, mock }) => {
    mock.addConversation({ title: 'Pancakes', agoMinutes: 5, messages: [
      { role: 'user', content: 'How do I make pancakes?' },
      { role: 'assistant', content: 'Mix flour, eggs and milk.' },
      { role: 'user', content: 'Can I use oat milk?' },
      { role: 'assistant', content: 'Yes, oat milk works well.' },
    ] });
    await login(page);
    await expect(page.getByText('Yes, oat milk works well.')).toBeVisible({ timeout: 10_000 });
    await composer(page).click();

    await page.keyboard.press('Control+f');
    const search = page.getByPlaceholder('Search messages...');
    await expect(search).toBeFocused();
    await page.keyboard.type('milk');
    await expect(page.getByText('1/3')).toBeVisible();
    await expect(page.locator('mark[data-search-hl]')).toHaveCount(3);

    await page.keyboard.press('Enter');
    await expect(page.getByText('2/3')).toBeVisible();
    await page.keyboard.press('Shift+Enter');
    await expect(page.getByText('1/3')).toBeVisible();

    await search.fill('waffles');
    await expect(page.getByText('0/0')).toBeVisible();
    await expect(page.locator('mark[data-search-hl]')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(search).toHaveCount(0);
  });

  test('Ctrl+F in the chat opens only the chat\'s search, not the file tree\'s', async ({ page }) => {
    await login(page);
    // The explorer's own search boxes, before: its toolbar has one already.
    const explorerSearch = page.getByPlaceholder('Search', { exact: true });
    const before = await explorerSearch.count();
    await composer(page).click();
    await page.keyboard.press('Control+f');
    await expect(page.getByPlaceholder('Search messages...')).toBeFocused();
    // The file tree's filter did not open beside it.
    await page.waitForTimeout(300);
    await expect(explorerSearch).toHaveCount(before);
  });
});
