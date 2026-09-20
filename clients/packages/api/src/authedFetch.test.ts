/**
 * The one authenticated `fetch` (#237).
 *
 * The three raw copies it replaced sent the bearer and did nothing about a
 * 401, so an access token past its hour turned every image into a "missing
 * file". The property here is the retry: exactly one, with whatever the
 * renderer's refresher hands back, and never a loop.
 */

import { installBridge } from '@kurisu/platform/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureAuthedFetch, fetchAuthedBytes, fetchAuthedResponse } from './authedFetch';
import { storage } from './storage';

const URL_UNDER_TEST = 'http://backend.test/character-assets/1/p1/base';

const respond = (status: number) => new Response(status === 200 ? 'bytes' : null, { status });

const authorizationOf = (call: unknown[]) => (call[1] as RequestInit).headers as Headers;

beforeEach(() => {
  installBridge({});
  storage.adoptToken('stale');
});

afterEach(() => {
  configureAuthedFetch({ refreshAccessToken: null });
  vi.restoreAllMocks();
});

describe('fetchAuthedBytes', () => {
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
});
