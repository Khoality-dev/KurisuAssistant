// @vitest-environment node
/**
 * The guard in front of the built-in MCP server.
 *
 * That server publishes `host_bash` and every app tool over HTTP, so these are
 * the tests that say who may reach them. Two failures matter most and both are
 * covered here: a web page completing the handshake (it used to be able to —
 * the server answered every origin with `Access-Control-Allow-Origin: *`), and
 * a caller with no token getting through.
 */

import { describe, expect, it } from 'vitest';
import {
  authorizeMcpRequest,
  bearerToken,
  secretsMatch,
  PUBLIC_PATHS,
} from '../electron/mcpServerAuth';

const TOKEN = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

const authed = (extra: Record<string, string> = {}) => ({
  method: 'GET',
  headers: { authorization: `Bearer ${TOKEN}`, ...extra },
});

describe('authorizeMcpRequest', () => {
  it('lets a local client through with the right token', () => {
    expect(authorizeMcpRequest(authed(), '/sse', TOKEN)).toEqual({ ok: true });
  });

  it('refuses a request with no Authorization header', () => {
    const result = authorizeMcpRequest({ method: 'GET', headers: {} }, '/sse', TOKEN);
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses a wrong token', () => {
    const result = authorizeMcpRequest(
      { method: 'POST', headers: { authorization: `Bearer ${OTHER}` } },
      '/messages',
      TOKEN,
    );
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses an Authorization header that is not a bearer token', () => {
    const result = authorizeMcpRequest(
      { method: 'GET', headers: { authorization: `Basic ${TOKEN}` } },
      '/sse',
      TOKEN,
    );
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  // A page cannot strip these, and no native MCP client sends them. This is
  // what stops a site the user is visiting from opening an SSE session.
  for (const header of ['origin', 'sec-fetch-site', 'sec-fetch-dest', 'sec-fetch-user', 'referer']) {
    it(`refuses a browser request carrying ${header}, token or not`, () => {
      const result = authorizeMcpRequest(authed({ [header]: 'https://evil.test' }), '/sse', TOKEN);
      expect(result).toMatchObject({ ok: false, status: 403 });
    });
  }

  // Node's fetch (undici) sends `sec-fetch-mode: cors` on every request, so
  // treating that header as a browser tell locks out the MCP clients this
  // endpoint exists for. The e2e caught it; this keeps it caught.
  it('allows a Node fetch client, which sends sec-fetch-mode but nothing else', () => {
    const result = authorizeMcpRequest(
      authed({ 'sec-fetch-mode': 'cors', 'user-agent': 'node', 'accept-language': '*' }),
      '/sse',
      TOKEN,
    );
    expect(result).toEqual({ ok: true });
  });

  it('refuses a browser even on the public health path', () => {
    const result = authorizeMcpRequest(
      { method: 'GET', headers: { origin: 'https://evil.test' } },
      '/health',
      TOKEN,
    );
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('answers /health without a token', () => {
    expect(authorizeMcpRequest({ method: 'GET', headers: {} }, '/health', TOKEN)).toEqual({ ok: true });
    expect(PUBLIC_PATHS.has('/health')).toBe(true);
  });

  it('does not treat any other path as public', () => {
    for (const path of ['/sse', '/messages', '/']) {
      expect(PUBLIC_PATHS.has(path)).toBe(false);
    }
  });

  it('refuses everything when no token has been minted', () => {
    const result = authorizeMcpRequest(authed(), '/sse', '');
    expect(result).toMatchObject({ ok: false, status: 503 });
  });

  it('reads a header sent as an array, as Node may deliver it', () => {
    const result = authorizeMcpRequest(
      { method: 'GET', headers: { authorization: [`Bearer ${TOKEN}`] } },
      '/sse',
      TOKEN,
    );
    expect(result).toEqual({ ok: true });
  });
});

describe('bearerToken', () => {
  it('accepts the scheme in any case and trims around the value', () => {
    expect(bearerToken({ headers: { authorization: '  bearer   abc  ' } })).toBe('abc');
    expect(bearerToken({ headers: { authorization: 'BEARER abc' } })).toBe('abc');
  });

  it('is null when the header is absent or another scheme', () => {
    expect(bearerToken({ headers: {} })).toBeNull();
    expect(bearerToken({ headers: { authorization: 'Basic abc' } })).toBeNull();
    expect(bearerToken({ headers: { authorization: 'Bearer' } })).toBeNull();
  });
});

describe('secretsMatch', () => {
  it('matches equal strings and nothing else', () => {
    expect(secretsMatch(TOKEN, TOKEN)).toBe(true);
    expect(secretsMatch(TOKEN, OTHER)).toBe(false);
  });

  it('survives a length mismatch instead of throwing', () => {
    expect(secretsMatch(TOKEN, 'short')).toBe(false);
    expect(secretsMatch('', TOKEN)).toBe(false);
  });
});
