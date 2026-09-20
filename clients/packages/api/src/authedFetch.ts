/**
 * `fetch` with the session's bearer token, and one retry when it is refused.
 *
 * The character asset routes authenticate by header only, so a plain `<img>`
 * or `<video>` cannot load them; the bytes are fetched here and handed on as
 * an object URL or a buffer. Three copies of that fetch used to exist, none of
 * which did anything about a 401 — the axios interceptor's refresh never sees
 * a raw `fetch`, so an access token past its hour made every image look like
 * a missing file (#237). This is the one copy, and the retry is its whole
 * point: on a 401 it asks the renderer's configured refresher for a fresh
 * token and tries exactly once more.
 *
 * Who refreshes depends on the window. The main renderer holds the refresh
 * token and calls `/auth/refresh`; the character window holds nothing and asks
 * the main renderer over IPC. Each configures its own refresher at startup.
 *
 * The bearer goes to the backend and nowhere else. A pose tree may carry an
 * absolute URL (the compositor passes `http…` through untouched), and the
 * packaged CSP lets the renderer fetch any http(s) origin, so without this
 * check a config pointing at a third-party host would hand that host the
 * session — and, on a 401, a freshly refreshed one. A foreign origin is
 * fetched plain, and a 401 from it is its own business.
 */

import { config } from './config';
import { storage } from './storage';

/** Resolves to a fresh access token, or null when none can be had. */
export type AccessTokenRefresher = () => Promise<string | null>;

let refresher: AccessTokenRefresher | null = null;

/** How this renderer gets a fresh access token when one is refused. */
export function configureAuthedFetch(options: { refreshAccessToken: AccessTokenRefresher | null }): void {
  refresher = options.refreshAccessToken;
}

function withToken(init: RequestInit | undefined, token: string | null): RequestInit {
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  else headers.delete('Authorization');
  return { ...init, headers };
}

/** Whether `url` is the backend's own origin — the only one that gets the bearer. */
export function isBackendOrigin(url: string): boolean {
  try {
    const base = new URL(config.apiBaseUrl);
    return new URL(url, base).origin === base.origin;
  } catch {
    return false;
  }
}

/** The response, after at most one refresh-and-retry on a 401. */
export async function fetchAuthedResponse(url: string, init?: RequestInit): Promise<Response> {
  if (!isBackendOrigin(url)) return fetch(url, withToken(init, null));

  const response = await fetch(url, withToken(init, storage.getToken()));
  if (response.status !== 401 || !refresher) return response;

  let fresh: string | null = null;
  try {
    fresh = await refresher();
  } catch {
    fresh = null;
  }
  if (!fresh) return response;
  return fetch(url, withToken(init, fresh));
}

function refused(url: string, response: Response): Error {
  return new Error(`Failed to load asset: ${url} (${response.status})`);
}

export async function fetchAuthedBlob(url: string, init?: RequestInit): Promise<Blob> {
  const response = await fetchAuthedResponse(url, init);
  if (!response.ok) throw refused(url, response);
  return response.blob();
}

/** The bytes, for a loader that parses a buffer rather than a URL — the VRM loader (#239) hands one to `GLTFLoader.parse`. */
export async function fetchAuthedBytes(url: string, init?: RequestInit): Promise<ArrayBuffer> {
  const response = await fetchAuthedResponse(url, init);
  if (!response.ok) throw refused(url, response);
  return response.arrayBuffer();
}
