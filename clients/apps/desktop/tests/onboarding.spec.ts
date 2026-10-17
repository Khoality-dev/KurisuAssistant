/**
 * Onboarding a new account (#342).
 *
 * The first sign-in to an account the server says is owed onboarding opens a
 * flow before the chat: the model (connect a provider, pick one of its
 * models), an optional persona with its voice and character, and the wake
 * word. Finishing writes it all and opens the chat on it; Skip keeps nothing.
 * Either way the server records it, so no device asks again. Every assertion
 * that matters is on what the mock stored, not only on the screen.
 */

import { test, expect } from './fixtures';
import { Page } from '@playwright/test';
import { MockBackend } from './mock/server';
import { VRM_MODEL_BYTES } from './mock/vrmFixture';

async function signIn(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
}

const dialog = (page: Page) => page.getByRole('dialog');

async function connectOllama(page: Page) {
  await expect(dialog(page).getByRole('heading', { name: 'Model' })).toBeVisible({ timeout: 15_000 });
  await page.getByLabel('Ollama address').fill('http://192.168.1.20:11434');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByText('Connected · 1 model')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'test-model' })).toBeChecked();
}

async function next(page: Page) {
  await page.getByRole('button', { name: 'Next' }).click();
}

test.describe('onboarding a new account', () => {
  test.beforeEach(({ mock }) => {
    mock.becomeNewAccount();
    mock.setVoices([{ id: 'kurisu_ja_01', name: 'Kurisu (Japanese)', model: 'gpt-sovits' }]);
  });

  test('a persona with a voice and a 3D model, and the chat opens on it', async ({ page, mock }) => {
    await signIn(page);
    await connectOllama(page);
    expect(mock.ollamaUrl).toBe('http://192.168.1.20:11434');
    await next(page);

    await expect(dialog(page).getByRole('heading', { name: 'Persona' })).toBeVisible();
    await page.getByLabel('Name').fill('Kurisu');
    await page.getByLabel('Calls you').fill('Okabe');
    await next(page);

    await expect(dialog(page).getByRole('heading', { name: 'Voice' })).toBeVisible();
    await page.getByText('Kurisu (Japanese)').click();
    await next(page);

    await expect(dialog(page).getByRole('heading', { name: 'Character' })).toBeVisible();
    // A 3D model needs its file before Next.
    await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();
    await page.getByLabel('VRM file').setInputFiles({ name: 'kurisu.vrm', mimeType: 'model/gltf-binary', buffer: VRM_MODEL_BYTES });
    await next(page);

    await expect(dialog(page).getByRole('heading', { name: 'Wake word' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Wake word' })).toHaveValue('Kurisu');
    // Nothing is written before the end.
    expect(mock.getPersonas()).toEqual([]);
    await page.getByRole('button', { name: 'Start chatting' }).click();

    await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
    const [persona] = mock.getPersonas();
    expect(persona).toMatchObject({ name: 'Kurisu', preferred_name: 'Okabe', voice_reference: 'kurisu_ja_01' });
    expect(persona.character_config?.vrm?.model).toBeTruthy();
    expect(mock.getAssistant()).toMatchObject({
      model_name: 'test-model',
      selected_persona_id: persona.id,
      trigger_word: 'Kurisu',
    });
    expect(mock.onboarded).toBe(true);
  });

  test('no persona: the assistant itself, and the wake word typed in', async ({ page, mock }) => {
    await signIn(page);
    await connectOllama(page);
    await next(page);

    await page.getByLabel('No persona').check();
    await next(page);
    // Voice and character belong to a persona: straight to the wake word.
    await expect(dialog(page).getByRole('heading', { name: 'Wake word' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Wake word' })).toHaveValue('');
    await page.getByRole('textbox', { name: 'Wake word' }).fill('Computer');
    await page.getByRole('button', { name: 'Start chatting' }).click();

    await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
    expect(mock.getPersonas()).toEqual([]);
    expect(mock.getAssistant()).toMatchObject({ model_name: 'test-model', selected_persona_id: null, trigger_word: 'Computer' });
    expect(mock.onboarded).toBe(true);
  });

  test('Skip keeps nothing, and no device is asked again', async ({ page, mock }) => {
    await signIn(page);
    await expect(dialog(page).getByRole('heading', { name: 'Model' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Skip' }).click();
    await expect(page.getByRole('heading', { name: 'Skip setup?' })).toBeVisible();
    await page.getByRole('dialog', { name: 'Skip setup?' }).getByRole('button', { name: 'Skip' }).click();

    await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
    expect(mock.onboarded).toBe(true);
    expect(mock.getPersonas()).toEqual([]);
    expect(mock.getAssistant()).toMatchObject({ model_name: null, trigger_word: null, selected_persona_id: null });
    // What another device would read on its first sign-in.
    const profile = await (await fetch(`${mock.url}/users/me`)).json();
    expect(profile.onboarding_pending).toBe(false);
  });
});

// The rest of the suite plays accounts that are set up; none of them is asked.
test('an account that is set up never sees it', async ({ page, mock }: { page: Page; mock: MockBackend }) => {
  await signIn(page);
  await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Skip setup?' })).toHaveCount(0);
  expect(mock.onboarded).toBe(true);
});
