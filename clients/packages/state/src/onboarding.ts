import type { Assistant, AssistantUpdate, ModelsResponse, UserProfile } from '@kurisu/models';

/**
 * Onboarding a new account (#342): the model, and only the model (#376),
 * offered once while `GET /users/me` says `onboarding_pending`. Once it has a
 * model the assistant can be asked for the rest — a persona, a voice, a wake
 * word — so onboarding asks for nothing else.
 *
 * The model is the account's, shared by the assistant and every persona. The
 * provider is saved as soon as it is connected, since the server must hold it
 * before it can list that provider's models; the model is saved on finishing.
 * Finishing or skipping ends the flow for the account, on every device.
 *
 * No React and no store here: the dialog renders it, and these tests drive it.
 */

/** The providers an account can connect, and what each needs. */
export const ONBOARDING_PROVIDERS = [
  { id: 'ollama', label: 'Ollama', field: 'ollama_url', input: 'Ollama address' },
  { id: 'gemini', label: 'Google Gemini', field: 'gemini_api_key', input: 'API key' },
  { id: 'nvidia', label: 'NVIDIA NIM', field: 'nvidia_api_key', input: 'API key' },
  { id: 'poe', label: 'Poe', field: 'poe_api_key', input: 'API key' },
] as const;

export type OnboardingProvider = (typeof ONBOARDING_PROVIDERS)[number]['id'];

export interface OnboardingModel {
  name: string;
  provider: string;
}

/** The calls the flow makes — `apiClient`'s, so a test can fake them. */
export interface OnboardingApi {
  updateUserProfile(fields: Partial<UserProfile> & { onboarded?: true }): Promise<unknown>;
  getModelsWithStatus(): Promise<ModelsResponse>;
  updateAssistant(data: AssistantUpdate): Promise<Assistant>;
}

/**
 * Finish: save [model] for the account, then end the flow. A failed save ends
 * nothing, so trying again simply saves it again.
 */
export async function finishOnboarding(
  api: Pick<OnboardingApi, 'updateAssistant' | 'updateUserProfile'>,
  model: OnboardingModel,
): Promise<void> {
  await api.updateAssistant({ model_name: model.name, provider_type: model.provider });
  await api.updateUserProfile({ onboarded: true });
}

/** Skip: nothing from the flow is kept, and nothing asks again on any device. */
export async function skipOnboarding(api: Pick<OnboardingApi, 'updateUserProfile'>): Promise<void> {
  await api.updateUserProfile({ onboarded: true });
}

/**
 * Connect [provider] with [value] (an address for Ollama, a key otherwise) and
 * list its models. The server keeps the provider: that is how it lists them.
 */
export async function connectProvider(
  api: Pick<OnboardingApi, 'updateUserProfile' | 'getModelsWithStatus'>,
  provider: OnboardingProvider,
  value: string,
): Promise<{ models: OnboardingModel[]; problem: string | null }> {
  const entry = ONBOARDING_PROVIDERS.find((p) => p.id === provider)!;
  const trimmed = value.trim();
  if (!trimmed) {
    return { models: [], problem: provider === 'ollama' ? 'Enter the Ollama address first.' : 'Enter the API key first.' };
  }
  await api.updateUserProfile({ [entry.field]: trimmed } as Partial<UserProfile>);
  const { models, unavailable } = await api.getModelsWithStatus();
  const mine = models.filter((m) => m.provider === provider);
  if (mine.length > 0) return { models: mine, problem: null };
  const why = unavailable.find((u) => u.provider === provider);
  return { models: [], problem: why?.detail ?? 'That provider has no models yet.' };
}
