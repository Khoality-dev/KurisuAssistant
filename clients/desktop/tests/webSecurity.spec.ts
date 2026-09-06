/**
 * The renderer cannot be driven somewhere else (#90).
 *
 * `webSecurity.test.ts` asserts the decisions; this asserts they are actually
 * wired to both windows in the running app, which is the part a unit test
 * cannot see. Remote content — an assistant message, a redirect from a backend
 * that has been taken over — must not be able to open a window carrying this
 * app's preload, or navigate the window it is already in.
 */

import { test, expect } from './fixtures';

/**
 * Deliberately unresolvable: the guards must refuse before anything is
 * fetched, so the assertion should not depend on the runner having a network,
 * or on how quickly a real host answers.
 */
const REMOTE = 'https://blocked.invalid/';

test.describe('window navigation guards', () => {
  test('window.open on a remote URL creates no second renderer', async ({ page, electronApp }) => {
    const before = electronApp.windows().length;

    // The attempt is made from a timer so this evaluate returns *before* the
    // renderer tries anything. An evaluate that is still in flight when the
    // guard fires never gets its answer, and Playwright will not close an app
    // with a call outstanding — on Linux CI that was a worker that could not
    // shut down after every test had passed. The attempt stays
    // renderer-initiated, which is what `setWindowOpenHandler` sees.
    await page.evaluate((url) => {
      setTimeout(() => { window.open(url, '_blank'); }, 0);
    }, REMOTE);

    // Give a window time to appear if the guard were missing, then assert none did.
    await page.waitForTimeout(1_500);

    expect(electronApp.windows().length).toBe(before);
    for (const win of electronApp.windows()) {
      expect(new URL(win.url()).protocol).not.toBe('https:');
    }
  });

  test('a remote navigation leaves the app where it was', async ({ page }) => {
    // The app has to be up before the attempt, not after: `will-navigate` is
    // prevented rather than completed, so Chromium keeps a pending navigation
    // and any locator query afterwards waits for one that never finishes. The
    // URL is the assertion that matters, and it needs no waiting.
    await expect(page.getByLabel('Username').or(page.getByPlaceholder('Type your message...')).first())
      .toBeVisible();
    const before = page.url();

    // Same shape as above, and for the same reason. `page.goto` would not do:
    // that is a browser-initiated navigation, which `will-navigate` never sees.
    await page.evaluate((url) => {
      setTimeout(() => { window.location.href = url; }, 0);
    }, REMOTE);
    await page.waitForTimeout(1_500);

    expect(page.url()).toBe(before);
  });

  test('the content security policy is served with the app document', async ({ page }) => {
    // Applied as a response header from the main process, so the packaged
    // documents served through the file: handler carry it too.
    const csp = await page.evaluate(async () => {
      const res = await fetch(window.location.href);
      return res.headers.get('content-security-policy');
    });

    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("'unsafe-eval'");
  });
});
