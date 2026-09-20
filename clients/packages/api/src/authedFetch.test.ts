/**
 * The one authenticated `fetch` (#237).
 *
 * The three raw copies it replaced sent the bearer and did nothing about a
 * 401, so an access token past its hour turned every image into a "missing
 * file". Two properties: the retry — exactly one, with whatever the renderer's
 * refresher hands back, never a loop — and the audience: the bearer goes to
 * the backend's origin and to no other host a config might name.
 */

import { installBridge, resetBridge } from '@kurisu/platform/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureAuthedFetch, fetchAuthedBlob, fetchAuthedBytes, fetchAuthedResponse, isBackendOrigin } from './authedFetch';
import { storage } from './storage';

const BACKEND = 'http://backend.test';
const URL_UNDER_TEST = `${BACKEND}/character-assets/1/p1/base`;
const FOREIGN_URL = 'https://cdn.example.net/poses/base.png';

const respond = (status: number) => new Response(status === 200 ? 'bytes' : null, { status });

const authorizationOf = (call: unknown[]) => (call[1] as RequestInit).headers as Headers;

beforeEach(() => {
  // A host with a configurable server, pointed at the mock's origin — the
  // Electron shape, where `config.apiBaseUrl` is whatever the user typed.
  installBridge({ capabilities: { configurableServer: true } });
  storage.setBackendUrl(BACKEND);
  storage.adoptToken('stale');
});

afterEach(() => {
  configureAuthedFetch({ refreshAccessToken: null });
  resetBridge();
  vi.restoreAllMocks();
});

describe('authedFetch', () => {
  it('sends the bearer, and on a 401 retries once with the refreshed token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(respond(401))
      .mockResolvedValueOnce(respond(200));
    const refresher = vi.fn(async () => 'fresh');
    configureAuthedFetch({ refreshAccessToken: refresher });

    const bytes = await fetchAuthedBytes(URL_UNDER_TEST);

    expect(new TextDecoder().decode(bytes)).toBe('bytes');
    expect(refresher).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authorizationOf(fetchMock.mock.calls[0]).get('Authorization')).toBe('Bearer stale');
    expect(authorizationOf(fetchMock.mock.calls[1]).get('Authorization')).toBe('Bearer fresh');
  });

  it('gives up after a second 401 rather than refreshing again', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(respond(401))
      .mockResolvedValueOnce(respond(401));
    const refresher = vi.fn(async () => 'fresh');
    configureAuthedFetch({ refreshAccessToken: refresher });

    await expect(fetchAuthedBytes(URL_UNDER_TEST)).rejects.toThrow('(401)');

    expect(refresher).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry when the refresher has nothing to give', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(respond(401));
    configureAuthedFetch({ refreshAccessToken: async () => null });

    const response = await fetchAuthedResponse(URL_UNDER_TEST);

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends no Authorization header at all when there is no token', async () => {
    storage.adoptToken(null);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(respond(200));

    await fetchAuthedBytes(URL_UNDER_TEST);

    expect(authorizationOf(fetchMock.mock.calls[0]).has('Authorization')).toBe(false);
  });

  it('hands back a blob for the object-URL callers', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(respond(200));

    const blob = await fetchAuthedBlob(URL_UNDER_TEST);

    expect(await blob.text()).toBe('bytes');
  });

  it('sends no bearer to a foreign origin, and does not refresh on its 401', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(respond(401));
    const refresher = vi.fn(async () => 'fresh');
    configureAuthedFetch({ refreshAccessToken: refresher });

    const response = await fetchAuthedResponse(FOREIGN_URL);

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authorizationOf(fetchMock.mock.calls[0]).has('Authorization')).toBe(false);
    expect(refresher).not.toHaveBeenCalled();
  });

  it('treats a root-relative path as the backend, and a lookalike host as foreign', () => {
    expect(isBackendOrigin('/character-assets/1/p1/base')).toBe(true);
    expect(isBackendOrigin(URL_UNDER_TEST)).toBe(true);
    expect(isBackendOrigin('http://backend.test.evil.example/x')).toBe(false);
    expect(isBackendOrigin('https://backend.test/x')).toBe(false); // the scheme is part of the origin
  });
});
