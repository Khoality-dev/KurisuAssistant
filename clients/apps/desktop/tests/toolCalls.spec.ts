/**
 * What a turn asks of the user and of the app (#312).
 *
 * Under Always ask the server puts each call to the user before it runs
 * (`tool_approval_request`), and a tool the app registered is run by the app
 * itself (`tool_call_request`). These drive both against the mock: the approval
 * bar's two answers, one of the app's own tools changing the account, and the
 * host-file tools on each side of `allowed_paths` — the boundary the app
 * enforces after any approval (docs/security.md).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
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

const approvalBar = (page: Page) => page.getByRole('region', { name: 'Tool approval' });

/** Grant the app a folder, as Settings → Host Access writes it: the main process reads it per call. */
function allowPaths(settingsFile: string, paths: string[]) {
  const current = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) : {};
  fs.writeFileSync(settingsFile, JSON.stringify({ ...current, allowed_paths: paths }));
}

test.describe('approving a tool', () => {
  test('an approved call runs, and the reply carries on after it', async ({ page, mock }) => {
    mock.setStream({
      chunks: [
        { content: 'Let me look. ', role: 'assistant', delayMs: 10 },
        {
          content: 'Notes.md, Q3.md', role: 'tool', name: 'drive_list', toolArgs: { path: '/Reports' },
          ask: { description: 'List the files in /Reports' },
        },
        { content: 'You have two reports.', role: 'assistant', delayMs: 10 },
      ],
    });
    await login(page);
    await send(page, 'What reports do I have?');

    const bar = approvalBar(page);
    await expect(bar).toBeVisible({ timeout: 10_000 });
    await expect(bar).toContainText('drive_list');
    await expect(bar).toContainText('List the files in /Reports');
    await expect(bar).toContainText('path: /Reports');
    await expect(bar).toContainText('by Kurisu');
    // The bar stands in for the message box while it waits.
    await expect(page.getByPlaceholder('Type your message...')).toHaveCount(0);

    await bar.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('You have two reports.').first()).toBeVisible({ timeout: 10_000 });
    await expect(bar).toHaveCount(0);
    await expect(page.getByPlaceholder('Type your message...')).toBeVisible();
    expect(mock.approvalResponses).toEqual([{ tool: 'drive_list', approved: true }]);
  });

  test('a denied call does not run, says so, and the turn ends there', async ({ page, mock }) => {
    mock.setStream({
      chunks: [
        { content: 'Deleting it. ', role: 'assistant', delayMs: 10 },
        { content: 'Deleted /Reports/Q3.md', role: 'tool', name: 'drive_delete', toolArgs: { path: '/Reports/Q3.md' }, ask: {} },
        { content: 'It is gone.', role: 'assistant', delayMs: 10 },
      ],
    });
    await login(page);
    await send(page, 'Delete the Q3 report');

    await approvalBar(page).getByRole('button', { name: 'Deny' }).click();
    await expect(approvalBar(page)).toHaveCount(0);
    await expect(page.getByText('drive_delete').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Deleted /Reports/Q3.md')).toHaveCount(0);
    await expect(page.getByText('It is gone.')).toHaveCount(0);
    await expect(page.getByPlaceholder('Type your message...')).toBeEnabled();
    expect(mock.approvalResponses).toEqual([{ tool: 'drive_delete', approved: false }]);

    // The denial is what the server kept.
    const conversation = mock.getConversation(mock.getConversations()[0].id)!;
    expect(conversation.messages.find((m) => m.role === 'tool')).toMatchObject({ name: 'drive_delete', tool_status: 'denied' });
  });

  test('Escape denies the call', async ({ page, mock }) => {
    mock.setStream({
      chunks: [{ content: 'ran', role: 'tool', name: 'drive_write', toolArgs: { path: '/a.md' }, ask: {} }],
    });
    await login(page);
    await send(page, 'Write a note');
    await expect(approvalBar(page)).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(approvalBar(page)).toHaveCount(0);
    await expect.poll(() => mock.approvalResponses).toEqual([{ tool: 'drive_write', approved: false }]);
  });
});

test.describe('the app\'s own tools', () => {
  test('one of the app\'s tools runs here and changes the account on the server', async ({ page, mock }) => {
    mock.setStream({
      chunks: [
        {
          content: '', role: 'tool', name: 'app_create_skill', onClient: true,
          toolArgs: { name: 'Haiku', instructions: 'Answer in a haiku.' },
        },
        { content: 'Your skill is ready.', role: 'assistant', delayMs: 10 },
      ],
    });
    await login(page);
    await send(page, 'Make a haiku skill');

    await expect(page.getByText('Your skill is ready.').first()).toBeVisible({ timeout: 10_000 });
    expect(mock.toolCallResponses).toHaveLength(1);
    expect(mock.toolCallResponses[0]).toMatchObject({ tool: 'app_create_skill', isError: false });
    const skills = await (await fetch(`${mock.url}/skills`)).json();
    expect(skills).toEqual([expect.objectContaining({ name: 'Haiku', instructions: 'Answer in a haiku.' })]);
  });

  test('a file inside an allowed folder is read with no prompt', async ({ page, mock, appPaths }) => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kurisu-host-'));
    const file = path.join(folder, 'todo.txt');
    fs.writeFileSync(file, 'buy milk');
    allowPaths(appPaths.settingsFile, [folder]);
    mock.setStream({
      chunks: [
        { content: '', role: 'tool', name: 'host_read', toolArgs: { path: file }, onClient: true },
        { content: 'It says to buy milk.', role: 'assistant', delayMs: 10 },
      ],
    });
    try {
      await login(page);
      await send(page, 'What is on my list?');
      await expect(page.getByText('It says to buy milk.').first()).toBeVisible({ timeout: 10_000 });
      await expect(approvalBar(page)).toHaveCount(0);
      expect(mock.toolCallResponses[0].isError).toBe(false);
      expect(mock.toolCallResponses[0].content).toContain('buy milk');
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  test('a file outside every allowed folder is asked about, and refused when I say no', async ({ page, mock, appPaths }) => {
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'kurisu-host-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kurisu-outside-'));
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'the password is swordfish');
    allowPaths(appPaths.settingsFile, [allowed]);
    mock.setStream({
      chunks: [
        { content: '', role: 'tool', name: 'host_read', toolArgs: { path: secret }, onClient: true },
        { content: 'Here it is.', role: 'assistant', delayMs: 10 },
      ],
    });
    try {
      await login(page);
      await send(page, 'Read that file');

      // The app's own gate, with its own choices: this call, this session, always, or no.
      const bar = approvalBar(page);
      await expect(bar).toBeVisible({ timeout: 10_000 });
      await expect(bar).toContainText('host_read');
      for (const choice of ['Accept', 'Auto-Accept for this session', 'Always Accept', 'Deny']) {
        await expect(bar.getByRole('button', { name: choice, exact: true })).toBeVisible();
      }
      await bar.getByRole('button', { name: 'Deny', exact: true }).click();

      await expect.poll(() => mock.toolCallResponses.length, { timeout: 10_000 }).toBe(1);
      expect(mock.toolCallResponses[0].isError).toBe(true);
      expect(mock.toolCallResponses[0].content).not.toContain('swordfish');
      // The server reads "Denied by user" as a denial, and the turn ends there.
      await expect(page.getByText('Here it is.')).toHaveCount(0);
      // Saying no granted nothing.
      expect(JSON.parse(fs.readFileSync(appPaths.settingsFile, 'utf-8')).allowed_paths).toEqual([allowed]);
    } finally {
      fs.rmSync(allowed, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test.describe('Settings → Host Access', () => {
  test('a folder added there is granted to the app, and removing it takes it back', async ({ page, mock, appPaths }) => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kurisu-grant-'));
    try {
      await login(page);
      await page.locator('button').filter({
        has: page.locator('[data-testid="SettingsOutlinedIcon"], [data-testid="SettingsIcon"]'),
      }).first().click();
      await page.getByText('Host Access', { exact: true }).first().click();

      await page.getByPlaceholder(/Absolute path/).fill(folder);
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(page.getByText(folder, { exact: true })).toBeVisible();
      const granted = () => (fs.existsSync(appPaths.settingsFile) ? JSON.parse(fs.readFileSync(appPaths.settingsFile, 'utf-8')).allowed_paths ?? [] : []);
      await expect.poll(granted).toEqual([folder]);

      await page.getByText(folder, { exact: true }).locator('xpath=ancestor::*[.//button][1]').getByRole('button').click();
      await expect(page.getByText(folder, { exact: true })).toHaveCount(0);
      await expect.poll(granted).toEqual([]);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
