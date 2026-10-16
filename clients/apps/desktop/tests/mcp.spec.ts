/**
 * Tests for Settings › Tools (#360):
 *   - The server's own tools are listed from GET /tools, grouped, each tagged by
 *     whether it only looks — and nothing switches one on or off
 *   - User-defined MCP servers are listed from GET /mcp-servers
 *   - Creating a new MCP server hits POST /mcp-servers with the right payload
 *   - Removing a server hits DELETE and takes its row away
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
  await page.getByText('Tools', { exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Tools', exact: true })).toBeVisible({ timeout: 10_000 });
}

test.describe('tools & MCP', () => {
  test("lists the server's own tools by feature, tagged Reads or Changes, with no switches", async ({ page, mock }) => {
    mock.setTools({
      server: [
        { name: 'drive_read', description: 'Read a drive file', read_only: true },
        { name: 'drive_write', description: 'Write a drive file' },
      ],
    });

    await login(page);
    await openTools(page);

    await page.locator('section').getByRole('button', { name: /Kurisu Drive/ }).click();
    const read = page.getByRole('button', { name: /drive_read/ });
    const write = page.getByRole('button', { name: /drive_write/ });
    await expect(read).toContainText('Reads');
    await expect(write).toContainText('Changes');
    // Every tool is always available: nothing on the page turns one off.
    await expect(page.getByRole('checkbox')).toHaveCount(0);
  });

  test('the search box finds a tool inside a closed group', async ({ page, mock }) => {
    mock.setTools({ server: [{ name: 'calendar_list', description: 'Your events', read_only: true }] });
    await login(page);
    await openTools(page);

    await expect(page.getByText('calendar_list')).toHaveCount(0);
    await page.getByLabel('Search tools').fill('events');
    await expect(page.getByText('calendar_list')).toBeVisible();
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

    await page.getByRole('button', { name: 'Add MCP server' }).click();

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

  test('Remove takes the server away and calls DELETE', async ({ page, mock }) => {
    const server = mock.addMcpServer({
      name: 'disposable-server',
      transport_type: 'sse',
      url: 'http://delete.me/sse',
    });

    await login(page);
    await openTools(page);

    await expect(page.getByText('disposable-server').first()).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: /disposable-server/ }).click();
    await page.getByRole('button', { name: 'Remove' }).click();

    await expect(page.getByText('disposable-server')).toHaveCount(0, { timeout: 5_000 });
    expect(mock.getMcpServers().find((s) => s.id === server.id)).toBeUndefined();
  });
});
