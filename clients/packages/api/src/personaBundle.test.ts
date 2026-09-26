/**
 * A persona export that carries its character, and the import that restores it (#248).
 *
 * The JSON export stays what it was; `character: true` asks for the v4 bundle,
 * `exportPersonaSize` says how big it is first, and a bundle goes back as a raw
 * streamed body — the route is not multipart, and a model does not finish
 * inside the default timeout.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';
import { apiClient } from './client';
import { describeRequestFailure } from './requestFailure';

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
      throw Object.assign(new Error(`status ${status}`), { response, config, isAxiosError: true });
    }
    return response;
  };
}

describe('exportPersona', () => {
  it('asks for the JSON file by default, as before', async () => {
    const seen: InternalAxiosRequestConfig[] = [];
    axiosInstance.defaults.adapter = respond(200, new Blob(['{}']), seen);
    await apiClient.exportPersona(3);
    expect(seen[0].url).toBe('/personas/3/export');
    expect(seen[0].params ?? {}).toEqual({});
    expect(seen[0].responseType).toBe('blob');
  });

  it('asks for the bundle with character=true and no timeout', async () => {
    const seen: InternalAxiosRequestConfig[] = [];
    axiosInstance.defaults.adapter = respond(200, new Blob(['PK']), seen);
    await apiClient.exportPersona(3, { character: true });
    expect(seen[0].url).toBe('/personas/3/export');
    expect(seen[0].params).toEqual({ character: true });
    expect(seen[0].responseType).toBe('blob');
    expect(seen[0].timeout).toBe(0);
  });

  it("reads the server's refusal out of a blob body", async () => {
    const body = new Blob([JSON.stringify({ detail: { code: 'unreadable_character', message: 'Cannot read it.' } })]);
    axiosInstance.defaults.adapter = respond(409, body);
    const error = await apiClient.exportPersona(3, { character: true }).catch((e) => e);
    expect(describeRequestFailure(error)).toBe('Cannot read it.');
  });
});

describe('exportPersonaSize', () => {
  it("returns the server's figures", async () => {
    const size = { character: { kind: 'vrm', files: 2, bytes: 42, vrm_bytes: 40 } };
    const seen: InternalAxiosRequestConfig[] = [];
    axiosInstance.defaults.adapter = respond(200, size, seen);
    expect(await apiClient.exportPersonaSize(3)).toEqual(size);
    expect(seen[0].url).toBe('/personas/3/export/size');
  });
});

describe('importPersonaBundle', () => {
  it('POSTs the zip as the raw body, with no timeout', async () => {
    const seen: InternalAxiosRequestConfig[] = [];
    axiosInstance.defaults.adapter = respond(200, { id: 7, name: 'Kurisu (2)' }, seen);
    const file = new File(['PK'], 'Kurisu.zip');
    const persona = await apiClient.importPersonaBundle(file);
    expect(persona.id).toBe(7);
    expect(seen[0].method).toBe('post');
    expect(seen[0].url).toBe('/personas/import/bundle');
    // Not multipart: the route reads the body as the zip itself. (The body
    // object is not compared — the test DOM's File is not one axios knows,
    // so it serialises it; a browser's goes out as-is, as the model upload's.)
    expect(seen[0].headers['Content-Type']).toBe('application/zip');
    expect(seen[0].timeout).toBe(0);
  });

  it('turns a refusal into a CharacterUploadError with its code', async () => {
    axiosInstance.defaults.adapter = respond(507, { detail: { code: 'quota', message: 'Full.', used_bytes: 1, quota_bytes: 2 } });
    await expect(apiClient.importPersonaBundle(new Blob(['PK']))).rejects.toMatchObject({
      name: 'CharacterUploadError',
      code: 'quota',
      status: 507,
      message: 'Full.',
    });
  });
});

describe('describeRequestFailure', () => {
  it("shows a structured refusal's message", () => {
    const error = { response: { status: 409, data: { detail: { code: 'x', message: 'Why it refused.' } } } };
    expect(describeRequestFailure(error)).toBe('Why it refused.');
  });
});
