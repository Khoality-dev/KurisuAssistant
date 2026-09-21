/**
 * What the login screen says when the failure is not the app's (#263).
 *
 * A proxy with a LAN allow-list, or a dead upstream behind one, answers with
 * its own HTML page and no JSON `detail`. The screen used to fall through to
 * the HTTP library's "Request failed with status code 403", which names
 * nothing a person can check. The mock stands in for the proxy; the sentence
 * is the assertion.
 */

import { test, expect } from './fixtures';

test.describe('login failures that are not the app', () => {
  test("a proxy's 403 says something in front of the server refused this device", async ({ page, mock }) => {
    mock.refuseLikeAProxy(403);

    await page.getByLabel('Username').fill('tester');
    await page.getByLabel('Password').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();

    await expect(
      page.getByText("Something in front of the server refused this device (HTTP 403). Check the server address, and whether the operator's proxy allows your network."),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Request failed with status code/)).toHaveCount(0);
  });

  test('a dead upstream behind the proxy is named as such', async ({ page, mock }) => {
    mock.refuseLikeAProxy(502);

    await page.getByLabel('Username').fill('tester');
    await page.getByLabel('Password').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();

    await expect(page.getByText('The server is not reachable behind its proxy (HTTP 502).')).toBeVisible({ timeout: 10_000 });
  });
});
