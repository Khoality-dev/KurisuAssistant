import { describe, expect, it, vi } from 'vitest';
import {
  OnboardingRun,
  connectProvider,
  defaultWakeWord,
  onboardingSteps,
  skipOnboarding,
  type OnboardingApi,
  type OnboardingChoices,
} from './onboarding';

/** A recording fake of the four calls finishing makes. */
function fakeApi(overrides: Partial<OnboardingApi> = {}) {
  const calls: Array<[string, unknown]> = [];
  const api: OnboardingApi = {
    updateUserProfile: vi.fn(async (fields) => { calls.push(['profile', fields]); }),
    getModelsWithStatus: vi.fn(async () => ({ models: [{ name: 'qwen3:8b', provider: 'ollama' }], unavailable: [] })),
    createPersona: vi.fn(async (data) => { calls.push(['persona', data]); return { id: 7, name: data.name } as never; }),
    uploadCharacterModel: vi.fn(async (id, file) => { calls.push(['model', { id, size: (file as Blob).size }]); return {} as never; }),
    updateAssistant: vi.fn(async (data) => { calls.push(['assistant', data]); return {} as never; }),
    ...overrides,
  };
  return { api, calls };
}

const withPersona: OnboardingChoices = {
  model: { name: 'qwen3:8b', provider: 'ollama' },
  persona: { name: 'Kurisu', preferredName: 'Okabe', avatarUuid: 'img-1', voice: 'voice-a', vrmFile: new Blob(['glb']) },
  wakeWord: 'Kurisu',
};

describe('onboarding (#342)', () => {
  it('asks for voice and character only when there is a persona', () => {
    expect(onboardingSteps(true)).toEqual(['model', 'persona', 'voice', 'character', 'wakeWord']);
    expect(onboardingSteps(false)).toEqual(['model', 'persona', 'wakeWord']);
  });

  it("starts the wake word as the persona's name, and empty without one", () => {
    expect(defaultWakeWord('Kurisu')).toBe('Kurisu');
    expect(defaultWakeWord('  ')).toBe('');
    expect(defaultWakeWord(null)).toBe('');
  });

  it('finishes in order: the persona, its model, then the account, then the flag', async () => {
    const { api, calls } = fakeApi();
    const result = await new OnboardingRun(api).finish(withPersona);

    expect(result).toEqual({ personaId: 7 });
    expect(calls).toEqual([
      ['persona', { name: 'Kurisu', preferred_name: 'Okabe', avatar_uuid: 'img-1', voice_reference: 'voice-a' }],
      ['model', { id: 7, size: 3 }],
      // One write for the account: the model, the persona in use and the wake word.
      ['assistant', { model_name: 'qwen3:8b', provider_type: 'ollama', selected_persona_id: 7, trigger_word: 'Kurisu' }],
      ['profile', { onboarded: true }],
    ]);
  });

  it('without a persona, the assistant answers as itself and an empty wake word is none', async () => {
    const { api, calls } = fakeApi();
    await new OnboardingRun(api).finish({ model: null, persona: null, wakeWord: '  ' });
    expect(calls).toEqual([
      ['assistant', { selected_persona_id: null, trigger_word: null }],
      ['profile', { onboarded: true }],
    ]);
  });

  it('a retry after a failure goes on from where it stopped, never making a second persona', async () => {
    let fail = true;
    const { api, calls } = fakeApi({
      uploadCharacterModel: vi.fn(async () => {
        if (fail) throw new Error('The model is too large.');
        calls.push(['model', 'ok']);
        return {} as never;
      }),
    });
    const run = new OnboardingRun(api);
    await expect(run.finish(withPersona)).rejects.toThrow('The model is too large.');
    expect(run.failedAt).toBe('character');

    fail = false;
    await run.finish(withPersona);
    expect(calls.filter(([k]) => k === 'persona')).toHaveLength(1);
    expect(calls.map(([k]) => k)).toEqual(['persona', 'model', 'assistant', 'profile']);
  });

  it('reports each part as it goes, for the progress screen', async () => {
    const { api } = fakeApi();
    const seen: string[] = [];
    await new OnboardingRun(api).finish(withPersona, (part) => seen.push(part));
    expect(seen).toEqual(['persona', 'character', 'assistant', 'done']);
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
