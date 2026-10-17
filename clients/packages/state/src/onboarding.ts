import type { Assistant, AssistantUpdate, ModelsResponse, Persona, PersonaCreate, UserProfile } from '@kurisu/models';

/**
 * Onboarding a new account (#342): the model, an optional first persona, and
 * the wake word, offered once while `GET /users/me` says `onboarding_pending`.
 *
 * The model and the wake word are the account's, shared by the assistant and
 * every persona; the persona only changes who speaks. Nothing the user picks
 * is written until they finish — except a provider they connect, which the
 * server must hold before it can list that provider's models. Finishing or
 * skipping ends the flow for the account, on every device.
 *
 * No React and no store here: the dialog renders it, and these tests drive it.
 */

export type OnboardingStep = 'model' | 'persona' | 'voice' | 'character' | 'wakeWord';

/** The steps in order. Voice and character belong to a persona and are skipped without one. */
export function onboardingSteps(withPersona: boolean): OnboardingStep[] {
  return withPersona ? ['model', 'persona', 'voice', 'character', 'wakeWord'] : ['model', 'persona', 'wakeWord'];
}

/** The wake word starts as the persona's name, and empty without one. */
export function defaultWakeWord(personaName: string | null): string {
  return personaName?.trim() ?? '';
}

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

export interface OnboardingChoices {
  /** Null leaves the account without one; the chat asks at the first message. */
  model: OnboardingModel | null;
  /** Null: the assistant answers as itself. */
  persona: {
    name: string;
    preferredName: string;
    avatarUuid: string | null;
    voice: string | null;
    /** A `.vrm` to make its character; null for none yet. */
    vrmFile: Blob | null;
  } | null;
  /** Empty for no wake word. */
  wakeWord: string;
}

/** The calls the flow makes — `apiClient`'s, so a test can fake them. */
export interface OnboardingApi {
  updateUserProfile(fields: Partial<UserProfile> & { onboarded?: true }): Promise<unknown>;
  getModelsWithStatus(): Promise<ModelsResponse>;
  createPersona(data: PersonaCreate): Promise<Persona>;
  uploadCharacterModel(personaId: number, file: Blob, opts?: { onProgress?: (loaded: number, total: number) => void }): Promise<unknown>;
  updateAssistant(data: AssistantUpdate): Promise<Assistant>;
}

/** What finishing is doing now, for the progress screen. */
export type FinishPart = 'persona' | 'character' | 'assistant' | 'done';

/**
 * Finishing, as one retryable run: each part is done once, so a retry after a
 * failed upload goes on from there instead of making a second persona.
 */
export class OnboardingRun {
  private personaId: number | null = null;
  private readonly done = new Set<FinishPart>();
  /** The part the last attempt stopped at, or null. */
  failedAt: FinishPart | null = null;

  constructor(private readonly api: OnboardingApi) {}

  async finish(
    choices: OnboardingChoices,
    onPart?: (part: FinishPart) => void,
    onUploadProgress?: (loaded: number, total: number) => void,
  ): Promise<{ personaId: number | null }> {
    const persona = choices.persona;
    const step = async (part: FinishPart, work: () => Promise<void>) => {
      if (this.done.has(part)) return;
      onPart?.(part);
      try {
        await work();
      } catch (e) {
        this.failedAt = part;
        throw e;
      }
      this.done.add(part);
    };
    this.failedAt = null;

    if (persona) {
      await step('persona', async () => {
        const created = await this.api.createPersona({
          name: persona.name.trim(),
          ...(persona.preferredName.trim() ? { preferred_name: persona.preferredName.trim() } : {}),
          ...(persona.avatarUuid ? { avatar_uuid: persona.avatarUuid } : {}),
          ...(persona.voice ? { voice_reference: persona.voice } : {}),
        });
        this.personaId = created.id;
      });
      if (persona.vrmFile) {
        const file = persona.vrmFile;
        await step('character', async () => {
          await this.api.uploadCharacterModel(this.personaId!, file, { onProgress: onUploadProgress });
        });
      }
    }

    await step('assistant', async () => {
      const wake = choices.wakeWord.trim();
      await this.api.updateAssistant({
        ...(choices.model ? { model_name: choices.model.name, provider_type: choices.model.provider } : {}),
        selected_persona_id: persona ? this.personaId : null,
        trigger_word: wake || null,
      });
    });
    await this.api.updateUserProfile({ onboarded: true });
    onPart?.('done');
    return { personaId: persona ? this.personaId : null };
  }
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
