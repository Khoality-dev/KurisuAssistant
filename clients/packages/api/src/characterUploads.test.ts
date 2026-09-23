/**
 * Character-asset uploads (#236): the digest the request carries, and the one
 * error type every failure becomes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';
import { apiClient } from './client';
import { CharacterUploadError, sha256Hex, toCharacterUploadError } from './characterUploads';

// sha256("abc")
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('sha256Hex', () => {
  it('is the lowercase hex digest of the bytes', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe(ABC);
  });
});

describe('toCharacterUploadError', () => {
  it('keeps the code, message and figures of a structured refusal', () => {
    const err = toCharacterUploadError({
      response: { status: 507, data: { detail: { code: 'quota', message: 'Full.', used_bytes: 10, quota_bytes: 20 } } },
    });
    expect(err).toBeInstanceOf(CharacterUploadError);
    expect(err.code).toBe('quota');
    expect(err.status).toBe(507);
    expect(err.message).toBe('Full.');
    expect(err.usedBytes).toBe(10);
    expect(err.quotaBytes).toBe(20);
  });

  it('carries the ceiling of a 413', () => {
    const err = toCharacterUploadError({
      response: { status: 413, data: { detail: { code: 'too_large', message: 'Big.', max_bytes: 100 } } },
    });
    expect(err.code).toBe('too_large');
    expect(err.maxBytes).toBe(100);
  });

  it("reads nginx's own 413, which has no JSON, as too_large", () => {
    expect(toCharacterUploadError({ response: { status: 413, data: '<html>' } }).code).toBe('too_large');
  });

  it('turns a code this client does not know into unknown, keeping the message', () => {
    const err = toCharacterUploadError({ response: { status: 415, data: { detail: { code: 'new_thing', message: 'Nope.' } } } });
    expect(err.code).toBe('unknown');
    expect(err.message).toBe('Nope.');
  });

  it('keeps a plain string detail as the message', () => {
    const err = toCharacterUploadError({ response: { status: 404, data: { detail: 'Persona not found' } } });
    expect(err.code).toBe('unknown');
    expect(err.message).toBe('Persona not found');
  });

  it('names an unreachable server', () => {
    expect(toCharacterUploadError({ request: {}, code: 'ERR_NETWORK', message: 'Network Error' }).code).toBe('network');
  });

  it("reads an aborted request as cancelled, not as a failure", () => {
    expect(toCharacterUploadError({ name: 'CanceledError', code: 'ERR_CANCELED', message: 'canceled' }).code).toBe('cancelled');
  });

  it('passes one through unchanged', () => {
    const original = new CharacterUploadError('not_vrm', 'x');
    expect(toCharacterUploadError(original)).toBe(original);
  });
});

describe('apiClient character uploads', () => {
  const axiosInstance = (apiClient as unknown as { client: { defaults: { adapter: unknown } } }).client;
  const original = axiosInstance.defaults.adapter;
  afterEach(() => {
    axiosInstance.defaults.adapter = original;
  });

  function respond(status: number, data: unknown, seen: InternalAxiosRequestConfig[] = []): AxiosAdapter {
    return async (config) => {
      seen.push(config);
      const response = { data, status, statusText: '', headers: {}, config };
      if (status >= 400) {
        const error = Object.assign(new Error(`status ${status}`), { response, config, isAxiosError: true });
        throw error;
      }
      return response;
    };
  }

  it('PUTs the raw bytes with their digest and the file name', async () => {
    const seen: InternalAxiosRequestConfig[] = [];
    axiosInstance.defaults.adapter = respond(200, { model_url: '/character-assets/3/vrm/model' }, seen);
    const file = new File(['abc'], 'kurisu.vrm');
    await apiClient.uploadCharacterModel(3, file);
    expect(seen[0].method).toBe('put');
    expect(seen[0].url).toBe('/character-assets/3/vrm/model');
    expect(seen[0].params).toEqual({ sha256: ABC, filename: 'kurisu.vrm' });
    expect(seen[0].timeout).toBe(0);
  });

  it('throws a CharacterUploadError with the refusal code', async () => {
    axiosInstance.defaults.adapter = respond(415, { detail: { code: 'not_vrm', message: 'Not a VRM.' } });
    await expect(apiClient.uploadCharacterModel(3, new Blob(['x']))).rejects.toMatchObject({
      name: 'CharacterUploadError',
      code: 'not_vrm',
      status: 415,
    });
  });

  it('sends nothing when the signal aborted while the file was hashed', async () => {
    const seen: InternalAxiosRequestConfig[] = [];
    axiosInstance.defaults.adapter = respond(200, {}, seen);
    const controller = new AbortController();
    const file = new Blob(['abc']);
    const arrayBuffer = file.arrayBuffer.bind(file);
    // Abort during the hash: the read of the bytes is where it happens.
    file.arrayBuffer = async () => {
      controller.abort();
      return arrayBuffer();
    };
    await expect(apiClient.uploadCharacterModel(3, file, { signal: controller.signal })).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(seen).toHaveLength(0);
  });

  it('refuses to delete a clip in use with clip_in_use', async () => {
    axiosInstance.defaults.adapter = respond(409, { detail: { code: 'clip_in_use', message: 'In use.' } });
    await expect(apiClient.deleteCharacterClip(3, 'abcdef12')).rejects.toMatchObject({ code: 'clip_in_use' });
  });

  it('sends a clip name without its extension', async () => {
    const seen: InternalAxiosRequestConfig[] = [];
    axiosInstance.defaults.adapter = respond(200, { clip: {}, character_config: {} }, seen);
    await apiClient.uploadCharacterClip(3, new File(['abc'], 'shy-wave.vrma'), { loop: true });
    expect(seen[0].url).toBe('/character-assets/3/vrma');
    expect(seen[0].params).toEqual({ sha256: ABC, name: 'shy-wave', loop: true });
  });
});
