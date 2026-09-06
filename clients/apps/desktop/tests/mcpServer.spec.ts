/**
 * The built-in MCP server, exercised as an HTTP endpoint against the real app.
 *
 * `tests/mcpServerAuth.test.ts` covers the decision function; this covers the
 * wiring around it — that the server actually listens, actually consults the
 * guard, and actually binds loopback only. The endpoint publishes `host_bash`,
 * so "is it reachable, and by whom" is not a detail worth inferring from the
 * source.
 *
 * The port comes from the fixture, never the default: on 15599 these requests
 * would go to whatever install happens to be running on the developer's
 * machine.
 */

import { test, expect } from './fixtures';
import fs from 'fs';
import os from 'os';

/** The token the app minted on first run, read from its isolated settings. */
function tokenFrom(settingsFile: string): string {
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
  return settings.mcp_server_token;
}

test.describe('built-in MCP server', () => {
  test('mints a token, refuses callers without it, and serves the one that has it', async ({
    electronApp,
    appPaths,
  }) => {
    // The app has to be up before anything listens.
    await electronApp.firstWindow();
    const base = `http://127.0.0.1:${appPaths.mcpPort}`;

    // Health answers without a token — that is how a client tells "not running"
    // from "wrong credentials".
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok' });

    const token = tokenFrom(appPaths.settingsFile);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    // No token: refused before any MCP session exists.
    const anonymous = await fetch(`${base}/sse`);
    expect(anonymous.status).toBe(401);

    // Wrong token: same.
    const wrong = await fetch(`${base}/sse`, {
      headers: { authorization: `Bearer ${'0'.repeat(64)}` },
    });
    expect(wrong.status).toBe(401);

    // A browser is refused even holding the token. This is the drive-by case:
    // the server used to answer every origin with a wildcard CORS header, so a
    // page the user was visiting could open a session and call host tools.
    const fromPage = await fetch(`${base}/sse`, {
      headers: { authorization: `Bearer ${token}`, origin: 'https://evil.test' },
    });
    expect(fromPage.status).toBe(403);

    // The real thing: an SSE stream opens and names the message endpoint.
    const controller = new AbortController();
    const stream = await fetch(`${base}/sse`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const firstChunk = await stream.body!.getReader().read();
    expect(new TextDecoder().decode(firstChunk.value)).toContain('/messages');
    controller.abort();
  });

  test('listens on loopback only, not on a routable interface', async ({
    electronApp,
    appPaths,
  }) => {
    await electronApp.firstWindow();

    // Every non-loopback IPv4 address this machine answers on. Before the fix
    // the server bound 0.0.0.0, so each of these reached host_bash from the LAN.
    const external = Object.values(os.networkInterfaces())
      .flatMap((addresses) => addresses ?? [])
      .filter((address) => address.family === 'IPv4' && !address.internal)
      .map((address) => address.address);

    test.skip(external.length === 0, 'no external interface on this host');

    for (const host of external) {
      const reached = await fetch(`http://${host}:${appPaths.mcpPort}/health`, {
        signal: AbortSignal.timeout(2000),
      }).then(
        () => true,
        () => false,
      );
      expect(reached, `${host} must not reach the MCP server`).toBe(false);
    }
  });
});
