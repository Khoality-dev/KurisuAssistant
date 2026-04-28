/**
 * Tests for the Tools & MCP settings page:
 *   - Built-in and MCP tools are listed from GET /tools
 *   - User-defined MCP servers are listed from GET /mcp-servers
 *   - Creating a new MCP server hits POST /mcp-servers with the right payload
 *   - Deleting a server hits DELETE and removes the card
 */

import { test, expect } from './fixtures';
import { Page } from '@playwright/test';

async function login(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
}

async function openTools(page: Page) {
  const settingsBtn = page.locator('button').filter({
    has: page.locator('[data-testid="SettingsOutlinedIcon"], [data-testid="SettingsIcon"]'),
  }).first();
  await settingsBtn.click();
  await page.getByText('Tools & MCP', { exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Tools & Servers' })).toBeVisible({ timeout: 10_000 });
}

test.describe('tools & MCP', () => {
  test('lists built-in tools from /tools', async ({ page, mock }) => {
    mock.setTools({
      builtin: [
        { name: 'search_web', description: 'Search the web for information', builtin: true },
        { name: 'get_time', description: 'Get current time', builtin: true },
      ],
    });

    await login(page);
    await openTools(page);

    await expect(page.getByText('Built-in', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('search_web').first()).toBeVisible();
    await expect(page.getByText('get_time').first()).toBeVisible();
  });

  test('lists pre-configured user MCP servers', async ({ page, mock }) => {
    mock.addMcpServer({
      name: 'my-custom-server',
      transport_type: 'sse',
      url: 'http://example.test/sse',
      location: 'server',
    });

    await login(page);
    await openTools(page);

    await expect(page.getByText('my-custom-server').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('http://example.test/sse').first()).toBeVisible();
  });

  test('create new MCP server opens dialog and submits via POST /mcp-servers', async ({ page, mock }) => {
    await login(page);
    await openTools(page);

    await page.getByRole('button', { name: 'Add MCP Server' }).click();

    await expect(page.getByRole('heading', { name: 'New MCP Server' })).toBeVisible({ timeout: 5_000 });

    await page.getByLabel('Server Name').fill('search-engine');
    await page.getByLabel('URL').fill('http://127.0.0.1:9000/sse');

    await page.getByRole('button', { name: /^(Create|Save)$/ }).click();

    // Dialog closes and mock recorded the create request.
    await expect(page.getByRole('heading', { name: 'New MCP Server' })).toHaveCount(0, { timeout: 5_000 });
    expect(mock.lastMcpServerCreate).toMatchObject({
      name: 'search-engine',
      transport_type: 'sse',
      url: 'http://127.0.0.1:9000/sse',
    });

    // New server appears in the list.
    await expect(page.getByText('search-engine').first()).toBeVisible({ timeout: 5_000 });
  });

  test('delete removes the server card and calls DELETE', async ({ page, mock }) => {
    const server = mock.addMcpServer({
      name: 'disposable-server',
      transport_type: 'sse',
      url: 'http://delete.me/sse',
    });

    await login(page);
    await openTools(page);

    await expect(page.getByText('disposable-server').first()).toBeVisible({ timeout: 10_000 });

    // Find the card containing the server name, then the delete icon button within it.
    const card = page.locator(':scope', { has: page.getByText('disposable-server') }).first();
    await card.locator('button').filter({ has: page.locator('[data-testid="DeleteIcon"]') }).first().click();

    await expect(page.getByText('disposable-server')).toHaveCount(0, { timeout: 5_000 });
    expect(mock.getMcpServers().find((s) => s.id === server.id)).toBeUndefined();
  });
});
