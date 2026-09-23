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

/** An asset the backend refused or does not have; `status` says which. */
export class AssetRequestError extends Error {
  constructor(url: string, readonly status: number) {
    super(`Failed to load asset: ${url} (${status})`);
    this.name = 'AssetRequestError';
  }
}

/** The connection ended before `Content-Length` bytes arrived. */
export class DownloadInterruptedError extends Error {
  constructor(url: string, readonly received: number, readonly expected: number) {
    super(`The download of ${url} stopped at ${received} of ${expected} bytes.`);
    this.name = 'DownloadInterruptedError';
  }
}

function refused(url: string, response: Response): Error {
  return new AssetRequestError(url, response.status);
}

/**
 * Bytes received so far, and the total when the response said
 * (`Content-Length`); `null` when it did not.
 */
export type DownloadProgress = (received: number, total: number | null) => void;

/**
 * Read a body chunk by chunk, reporting as it goes. A 3D model is tens of
 * megabytes, and the character window says how far the download has got
 * rather than showing a spinner for half a minute. A body shorter than its
 * `Content-Length` is an interrupted download, not a model: it is refused
 * here with its own error rather than handed to a parser that would call it
 * a corrupt file.
 */
async function readWithProgress(url: string, response: Response, onProgress: DownloadProgress): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get('Content-Length'));
  const total = Number.isFinite(declared) && declared > 0 ? declared : null;
  const reader = response.body?.getReader?.();
  if (!reader) {
    const whole = await response.arrayBuffer();
    onProgress(whole.byteLength, total ?? whole.byteLength);
    return whole;
  }
  onProgress(0, total);
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    received += value.byteLength;
    onProgress(received, total);
  }
  if (total !== null && received < total) throw new DownloadInterruptedError(url, received, total);
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

export async function fetchAuthedBlob(url: string, init?: RequestInit): Promise<Blob> {
  const response = await fetchAuthedResponse(url, init);
  if (!response.ok) throw refused(url, response);
  return response.blob();
}

/**
 * The bytes, for a loader that parses a buffer rather than a URL — the VRM
 * loader (#239) hands one to `GLTFLoader.parse`. With `onProgress`, the body
 * is read in chunks and each one reported; the retry on a 401 is the same
 * either way, because progress starts only once a response is accepted.
 */
export async function fetchAuthedBytes(url: string, init?: RequestInit, onProgress?: DownloadProgress): Promise<ArrayBuffer> {
  const response = await fetchAuthedResponse(url, init);
  if (!response.ok) throw refused(url, response);
  return response.arrayBuffer(); // PROVE(3): progress backed out
}
