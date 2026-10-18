import { describe, expect, it, vi } from 'vitest';
import { connectProvider, finishOnboarding, skipOnboarding, type OnboardingApi } from './onboarding';

/** A recording fake of the calls onboarding makes. */
function fakeApi(overrides: Partial<OnboardingApi> = {}) {
  const calls: Array<[string, unknown]> = [];
  const api: OnboardingApi = {
    updateUserProfile: vi.fn(async (fields) => { calls.push(['profile', fields]); }),
    getModelsWithStatus: vi.fn(async () => ({ models: [{ name: 'qwen3:8b', provider: 'ollama' }], unavailable: [] })),
    updateAssistant: vi.fn(async (data) => { calls.push(['assistant', data]); return {} as never; }),
    ...overrides,
  };
  return { api, calls };
}

describe('onboarding (#342, #376)', () => {
  it('finishing saves the model, and nothing else, then ends the flow', async () => {
    const { api, calls } = fakeApi();
    await finishOnboarding(api, { name: 'qwen3:8b', provider: 'ollama' });
    // No persona, no voice, no wake word: once it has a model, the assistant can be asked for the rest.
    expect(calls).toEqual([
      ['assistant', { model_name: 'qwen3:8b', provider_type: 'ollama' }],
      ['profile', { onboarded: true }],
    ]);
  });

  it('a failed save ends nothing, and trying again saves it', async () => {
    let fail = true;
    const { api, calls } = fakeApi({
      updateAssistant: vi.fn(async (data) => {
        if (fail) throw new Error('offline');
        calls.push(['assistant', data]);
        return {} as never;
      }),
    });
    await expect(finishOnboarding(api, { name: 'qwen3:8b', provider: 'ollama' })).rejects.toThrow('offline');
    expect(calls).toEqual([]);

    fail = false;
    await finishOnboarding(api, { name: 'qwen3:8b', provider: 'ollama' });
    expect(calls.map(([k]) => k)).toEqual(['assistant', 'profile']);
  });

  it('skipping keeps nothing and only ends the flow', async () => {
    const { api, calls } = fakeApi();
    await skipOnboarding(api);
    expect(calls).toEqual([['profile', { onboarded: true }]]);
  });

  it('connecting a provider saves it and lists that provider’s models', async () => {
    const { api, calls } = fakeApi({
      getModelsWithStatus: vi.fn(async () => ({
        models: [{ name: 'qwen3:8b', provider: 'ollama' }, { name: 'gemini-2.5-flash', provider: 'gemini' }],
        unavailable: [],
      })),
    });
    const ollama = await connectProvider(api, 'ollama', ' http://192.168.1.20:11434 ');
    expect(calls).toEqual([['profile', { ollama_url: 'http://192.168.1.20:11434' }]]);
    expect(ollama).toEqual({ models: [{ name: 'qwen3:8b', provider: 'ollama' }], problem: null });

    calls.length = 0;
    await connectProvider(api, 'gemini', 'key-123');
    expect(calls).toEqual([['profile', { gemini_api_key: 'key-123' }]]);
  });

  it("says why a provider gave nothing, in the server's own words", async () => {
    const { api } = fakeApi({
      getModelsWithStatus: vi.fn(async () => ({
        models: [],
        unavailable: [{ provider: 'ollama', detail: 'Ollama at http://x:11434 could not be reached.' }],
      })),
    });
    expect(await connectProvider(api, 'ollama', 'http://x:11434')).toEqual({
      models: [],
      problem: 'Ollama at http://x:11434 could not be reached.',
    });
    const empty = fakeApi({ getModelsWithStatus: vi.fn(async () => ({ models: [], unavailable: [] })) });
    expect((await connectProvider(empty.api, 'ollama', 'http://x:11434')).problem).toBe('That provider has no models yet.');
    expect((await connectProvider(empty.api, 'ollama', '  ')).problem).toBe('Enter the Ollama address first.');
  });
});
