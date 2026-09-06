/**
 * Who is allowed to talk to the built-in MCP server.
 *
 * That server publishes every host and app tool — `host_bash` included — over
 * HTTP, so this guard is the whole security boundary in front of local code
 * execution. It lives in its own module, with no `electron` import, so it can
 * be unit-tested directly instead of only through a running app.
 *
 * Two rules:
 *
 * 1. **Nothing that looks like a browser.** A page the user happens to be
 *    visiting must not be able to drive these tools. What separates a page from
 *    a local process is the set of headers the browser attaches and script
 *    cannot forge — `Origin`, `Referer`, `Sec-Fetch-*`. A native MCP client
 *    (Claude Code and friends) sends none of them.
 * 2. **A bearer token on everything but /health.** Loopback is not an identity:
 *    another account on the same machine can open a socket to 127.0.0.1 exactly
 *    as easily as the user can.
 */

import { timingSafeEqual } from 'node:crypto';

export interface McpRequestLike {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

export type AuthResult =
  | { ok: true }
  | { ok: false; status: number; error: string; reason: string };

/**
 * Headers a browser sets on a cross-origin request and a page cannot remove.
 *
 * `sec-fetch-mode` is deliberately **not** here even though browsers send it:
 * Node's own `fetch` (undici) sets `sec-fetch-mode: cors` on every request, on
 * Node 18 and 24 alike, so testing it would refuse every MCP client built on
 * fetch — which is most of them, the SDK's SSE transport included. The other
 * three `Sec-Fetch-*` headers and `Origin` are browser-only in practice.
 */
const BROWSER_HEADERS = [
  'origin',
  'sec-fetch-site',
  'sec-fetch-dest',
  'sec-fetch-user',
  'referer',
] as const;

/** Paths that answer without a token. Nothing here may reveal or run anything. */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/health']);

function readHeader(req: McpRequestLike, name: string): string | undefined {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Constant-time string compare that also tolerates a length mismatch. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Still compare something of equal length so the answer does not come back
    // faster for a wrong-length guess than for a wrong-value one.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** Pull the token out of an `Authorization: Bearer …` header. */
export function bearerToken(req: McpRequestLike): string | null {
  const header = readHeader(req, 'authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Decide whether one request may proceed.
 *
 * @param pathname  the request path, already parsed by the caller
 * @param token     the server's expected bearer token
 */
export function authorizeMcpRequest(
  req: McpRequestLike,
  pathname: string,
  token: string,
): AuthResult {
  for (const name of BROWSER_HEADERS) {
    if (readHeader(req, name) !== undefined) {
      return {
        ok: false,
        status: 403,
        error: 'This endpoint does not serve browsers.',
        reason: `browser header: ${name}`,
      };
    }
  }

  if (PUBLIC_PATHS.has(pathname)) return { ok: true };

  if (!token) {
    return {
      ok: false,
      status: 503,
      error: 'MCP server has no access token configured.',
      reason: 'no token minted',
    };
  }

  const presented = bearerToken(req);
  if (presented === null) {
    return {
      ok: false,
      status: 401,
      error: 'Authorization: Bearer <token> required.',
      reason: 'no bearer token',
    };
  }

  if (!secretsMatch(presented, token)) {
    return {
      ok: false,
      status: 401,
      error: 'Invalid access token.',
      reason: 'token mismatch',
    };
  }

  return { ok: true };
}
