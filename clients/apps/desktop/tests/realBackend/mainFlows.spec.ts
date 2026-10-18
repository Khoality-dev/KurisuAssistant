/**
 * The main flows against the real backend (#313): signing in, a streamed
 * reply, a first run with no model, personas, the assistant's settings and
 * Kurisu Drive. What the app shows is checked, and so is what the server then
 * holds — read back through its API as the same account — and, for the chat,
 * what the server asked the model.
 */
import { test, expect, setUp, signIn, openSection, MOCK_MODEL } from './fixtures';

const composer = (page: import('@playwright/test').Page) => page.getByPlaceholder('Type your message...');

test.describe('the desktop app against the real backend', () => {
  test('signing in and a streamed reply, kept on the server', async ({ page, account, ollama }) => {
    await setUp(account, ollama);
    await ollama.script({ content: 'Hello from the real server, one word at a time.', delay_ms: 30 });
    await signIn(page, account);
    await expect(composer(page)).toBeVisible({ timeout: 20_000 });

    await composer(page).fill('Say hello');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Hello from the real server, one word at a time.').first()).toBeVisible({ timeout: 20_000 });

    // The server asked the account's model, with the message as sent.
    const chat = (await ollama.chats()).at(-1)!;
    expect(chat.model).toBe(MOCK_MODEL);
    expect(chat.messages.at(-1)).toMatchObject({ role: 'user', content: 'Say hello' });

    // And kept the conversation, titled after the first message.
    const conversations = await account.json<Array<{ id: number; title: string }>>('/conversations');
    expect(conversations.map((c) => c.title)).toEqual(['Say hello']);
    const detail = await account.json<{ messages: Array<{ role: string; content: string }> }>(`/conversations/${conversations[0].id}`);
    expect(detail.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Say hello'],
      ['assistant', 'Hello from the real server, one word at a time.'],
    ]);

    // Signing in again opens it.
    await page.getByRole('button', { name: 'Logout' }).click();
    await signIn(page, account);
    await expect(page.getByText('Hello from the real server, one word at a time.').first()).toBeVisible({ timeout: 20_000 });
  });

  test('a first run: onboarding connects the provider and picks the model, and the first message is answered', async ({ page, account, ollama }) => {
    await signIn(page, account);
    const onboarding = page.getByRole('dialog');
    await expect(onboarding.getByRole('heading', { name: 'Model' })).toBeVisible({ timeout: 20_000 });

    await page.getByLabel('Ollama address').fill(ollama.url);
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByText('Connected · 1 model')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('combobox', { name: 'Model' })).toHaveText(MOCK_MODEL);
    // The model is all onboarding asks for (#376).
    await page.getByRole('button', { name: 'Start chatting' }).click();
    await expect(composer(page)).toBeVisible({ timeout: 20_000 });

    const me = await account.json<{ onboarding_pending: boolean; ollama_url: string }>('/users/me');
    expect(me).toMatchObject({ onboarding_pending: false, ollama_url: ollama.url });
    expect(await account.json('/assistant')).toMatchObject({ model_name: MOCK_MODEL, trigger_word: null, selected_persona_id: null });
    expect(await account.json('/personas')).toEqual([]);

    await ollama.script({ content: 'Your first answer.' });
    await composer(page).fill('Hello?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Your first answer.').first()).toBeVisible({ timeout: 20_000 });
  });

  test('a first run that skips setup has no model, and the first message says so', async ({ page, account }) => {
    await signIn(page, account);
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Model' })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Skip' }).click();
    await page.getByRole('dialog', { name: 'Skip setup?' }).getByRole('button', { name: 'Skip' }).click();
    await expect(composer(page)).toBeVisible({ timeout: 20_000 });

    await composer(page).fill('Anyone there?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    // NO_MODEL_SELECTED: the prompt, not a red toast, and the message back in the box.
    await expect(page.getByRole('button', { name: 'Choose a model' })).toBeVisible({ timeout: 20_000 });
    await expect(composer(page)).toHaveValue('Anyone there?');
    expect(await account.json<unknown[]>('/conversations')).toEqual([]);
  });

  test('a persona made in Settings is on the server, and put in use it answers', async ({ page, account, ollama }) => {
    await setUp(account, ollama);
    await signIn(page, account);
    await expect(composer(page)).toBeVisible({ timeout: 20_000 });

    await openSection(page, 'Personas');
    await page.getByRole('button', { name: /New Persona|Create a persona/ }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New persona' });
    await dialog.getByLabel('Name').fill('Mayuri');
    await dialog.getByLabel('System prompt').fill('You are Mayuri. Say tuturu.');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('group', { name: 'Mayuri' })).toBeVisible({ timeout: 15_000 });
    const personas = await account.json<Array<{ id: number; name: string; system_prompt: string }>>('/personas');
    expect(personas).toEqual([expect.objectContaining({ name: 'Mayuri', system_prompt: 'You are Mayuri. Say tuturu.' })]);

    await page.getByRole('group', { name: 'Mayuri' }).getByRole('button', { name: 'Talk to' }).click();
    await expect.poll(async () => (await account.json<{ selected_persona_id: number | null }>('/assistant')).selected_persona_id, { timeout: 10_000 })
      .toBe(personas[0].id);

    await ollama.script({ content: 'Tuturu!' });
    await page.locator('button').filter({
      has: page.locator('[data-testid="ChatBubbleOutlineIcon"], [data-testid="ChatBubbleIcon"]'),
    }).first().click();
    await composer(page).fill('Hi Mayuri');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Tuturu!').first()).toBeVisible({ timeout: 20_000 });
    // The persona's prompt reached the model.
    const chat = (await ollama.chats()).at(-1)!;
    expect(chat.messages[0].content).toContain('You are Mayuri. Say tuturu.');
  });

  test('the assistant\'s settings saved in the app are the server\'s', async ({ page, account, ollama }) => {
    await setUp(account, ollama);
    await signIn(page, account);
    await expect(composer(page)).toBeVisible({ timeout: 20_000 });
    await openSection(page, 'Assistant');

    await page.getByLabel('Wake word').fill('Christina');
    await page.getByLabel('Memory notes').fill('Likes Dr Pepper.');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Assistant saved.')).toBeVisible({ timeout: 10_000 });
    expect(await account.json('/assistant')).toMatchObject({ trigger_word: 'Christina', memory: 'Likes Dr Pepper.', model_name: MOCK_MODEL });
  });

  test('Kurisu Drive: a folder made in the app, and a file edited in it, are on the server', async ({ page, account, ollama }) => {
    await setUp(account, ollama);
    const uploaded = await account.api('/drive/files?name=todo.md', { method: 'POST', body: 'buy milk', headers: { 'Content-Type': 'application/octet-stream' } });
    expect(uploaded.status, await uploaded.clone().text()).toBeLessThan(300);
    const { id: fileId } = await uploaded.json() as { id: number };

    await signIn(page, account);
    await expect(composer(page)).toBeVisible({ timeout: 20_000 });
    await page.getByRole('row', { name: /Kurisu Drive/ }).first().dblclick();
    await expect(page.getByRole('cell', { name: 'todo.md', exact: true })).toBeVisible({ timeout: 15_000 });

    await page.locator('button').filter({ has: page.locator('[data-testid="CreateNewFolderIcon"]') }).first().click();
    await page.getByPlaceholder('folder-name').fill('Receipts');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('cell', { name: 'Receipts', exact: true })).toBeVisible({ timeout: 15_000 });
    const nodes = await account.json<Array<{ name: string; is_dir: boolean }> | { nodes: Array<{ name: string; is_dir: boolean }> }>('/drive/nodes');
    const list = Array.isArray(nodes) ? nodes : nodes.nodes;
    expect(list.map((n) => [n.name, n.is_dir]).sort()).toEqual([['Receipts', true], ['todo.md', false]]);

    await page.getByRole('cell', { name: 'todo.md', exact: true }).dblclick();
    await expect(page.getByText('buy milk')).toBeVisible({ timeout: 15_000 });
    await page.locator('.monaco-editor').first().click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nbuy eggs');
    await page.keyboard.press('Control+s');
    await expect.poll(async () => (await (await account.api(`/drive/files/${fileId}/content`)).text()).replace(/\r\n/g, '\n'), { timeout: 15_000 })
      .toBe('buy milk\nbuy eggs');
  });

  test('a tool call the server puts to me runs once approved, and the reply carries on', async ({ page, account, ollama }) => {
    await setUp(account, ollama);
    const uploaded = await account.api('/drive/files?name=plan.md', { method: 'POST', body: 'trip', headers: { 'Content-Type': 'application/octet-stream' } });
    expect(uploaded.status).toBeLessThan(300);
    // The model asks for a tool, then answers once it has the result.
    await ollama.script(
      { tool_calls: [{ name: 'drive_list', arguments: { path: '/' } }] },
      { content: 'You have one file, plan.md.' },
    );
    await signIn(page, account);
    await expect(composer(page)).toBeVisible({ timeout: 20_000 });
    await composer(page).fill('What is on my drive?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    // Always ask, the default: the server asks before the call runs.
    const bar = page.getByRole('region', { name: 'Tool approval' });
    await expect(bar).toBeVisible({ timeout: 20_000 });
    await expect(bar).toContainText('drive_list');
    await bar.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('You have one file, plan.md.').first()).toBeVisible({ timeout: 20_000 });

    // The tool's result went back to the model.
    const followUp = (await ollama.chats()).at(-1)!;
    const toolMessage = followUp.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toContain('plan.md');
  });
});
