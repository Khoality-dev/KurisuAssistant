/**
 * Where a real session's tokens end up (#91).
 *
 * The unit tests pin the storage module's behaviour against a fake bridge. This
 * pins the whole path through the running app: log in, and check that nothing
 * readable is left in localStorage while the session still survives a reload —
 * which it can only do by coming back out of the main process's encrypted file.
 */

import { test, expect } from './fixtures';
import fs from 'fs';
import path from 'path';

const TOKEN_KEYS = ['kurisu_auth_token', 'kurisu_refresh_token'];

test.describe('session tokens', () => {
  test('never reach localStorage, and survive a reload from the keychain', async ({
    page,
    appPaths,
  }) => {
    // Everything below forks on whether this machine has a keychain at all. A
    // CI container or a Linux box with no secret service has none, and then the
    // deliberate outcome is that nothing is stored: an unencrypted 30-day
    // credential on disk is the thing being removed, not relocated.
    const secure = await page.evaluate(() =>
      (window as any).electron.credentials.isSecure() as Promise<boolean>,
    );

    // Remember me is on by default in the form, and disabled outright with no
    // keychain. Waiting on that state settles the async check the form makes.
    const rememberMe = page.getByLabel('Remember me');
    if (secure) {
      await expect(rememberMe).toBeEnabled();
      if (!(await rememberMe.isChecked())) await rememberMe.check();
    } else {
      await expect(rememberMe).toBeDisabled();
    }

    await page.getByLabel('Username').fill('tester');
    await page.getByLabel('Password').fill('password');
    await page.getByRole('button', { name: 'Login' }).click();
    await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });

    // The mock's token, so we can look for it by value as well as by key.
    const dumped = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
    for (const key of TOKEN_KEYS) {
      expect(dumped).not.toContain(key);
    }
    expect(dumped).not.toContain('test-access-token');
    expect(dumped).not.toContain('test-refresh-token');

    const credentialsFile = path.join(appPaths.userDataDir, 'credentials.json');

    await page.reload();

    if (secure) {
      // Reload wipes renderer memory, so coming back signed in means the token
      // was read out of the main process's encrypted file.
      await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
      const contents = fs.readFileSync(credentialsFile, 'utf-8');
      expect(contents).not.toContain('test-access-token');
      expect(contents).not.toContain('test-refresh-token');
    } else {
      // No keychain: nothing was written, and the session ends with the window.
      expect(fs.existsSync(credentialsFile)).toBe(false);
      await expect(page.getByRole('button', { name: 'Login' })).toBeVisible({ timeout: 15_000 });
    }
  });
});
