/**
 * Making and changing what the assistant is (#312): personas, skills and the
 * assistant's own settings, each checked on the mock's store after the click
 * that saves it — the screens list what the server holds, so a save that never
 * reached it would still look right until a reload.
 */
import { test, expect } from './fixtures';
import { Page } from '@playwright/test';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function login(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByPlaceholder('Type your message...')).toBeVisible({ timeout: 15_000 });
}

async function openSection(page: Page, section: string) {
  await page.locator('button').filter({
    has: page.locator('[data-testid="SettingsOutlinedIcon"], [data-testid="SettingsIcon"]'),
  }).first().click();
  await expect(page.getByText('Account', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await page.getByText(section, { exact: true }).first().click();
}

test.describe('personas', () => {
  test('a new persona is made with its picture, voice and words, and is on the server', async ({ page, mock }) => {
    mock.setVoices([{ id: 'kurisu_ja_01', name: 'Kurisu (Japanese)', model: 'gpt-sovits' }]);
    await login(page);
    await openSection(page, 'Personas');
    await page.getByRole('button', { name: 'New Persona' }).click();

    const dialog = page.getByRole('dialog', { name: 'New persona' });
    await expect(dialog).toBeVisible();
    await dialog.locator('input[type="file"][accept="image/*"]').setInputFiles({
      name: 'face.png', mimeType: 'image/png', buffer: Buffer.from(PNG_BASE64, 'base64'),
    });
    await expect.poll(() => mock.uploadedImages.length).toBe(1);
    await dialog.getByLabel('Name').fill('Mayuri');
    await dialog.getByLabel('Description').fill('A cheerful friend');
    await dialog.getByLabel('System prompt').fill('You are Mayuri. Say tuturu.');
    await dialog.getByLabel('Calls you').fill('Okarin');
    await dialog.getByLabel('Voice').click();
    await page.getByRole('option', { name: /Kurisu \(Japanese\)/ }).click();
    await dialog.getByRole('button', { name: 'Create' }).click();

    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Persona "Mayuri" created.')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Mayuri' })).toBeVisible();
    expect(mock.getPersonas().find((p) => p.name === 'Mayuri')).toMatchObject({
      description: 'A cheerful friend',
      system_prompt: 'You are Mayuri. Say tuturu.',
      preferred_name: 'Okarin',
      voice_reference: 'kurisu_ja_01',
      avatar_uuid: mock.uploadedImages[0],
    });
    // Made, not put in use: only the user puts the chat on a persona (#302).
    expect(mock.getAssistant().selected_persona_id).toBe(1);
  });

  test('a persona is edited, and the change is on the server', async ({ page, mock }) => {
    await login(page);
    await openSection(page, 'Personas');
    await page.getByRole('group', { name: 'Kurisu' }).click();

    const dialog = page.getByRole('dialog', { name: 'Edit Kurisu' });
    await dialog.getByLabel('System prompt').fill('You are Makise Kurisu, a neuroscientist.');
    await dialog.getByLabel('Name').fill('Makise Kurisu');
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByText('Persona "Makise Kurisu" saved.')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Makise Kurisu' })).toBeVisible();
    expect(mock.getPersonas().find((p) => p.id === 1)).toMatchObject({
      name: 'Makise Kurisu', system_prompt: 'You are Makise Kurisu, a neuroscientist.',
    });
  });

  test('a picture that is not an image is refused with the server\'s reason', async ({ page, mock }) => {
    await login(page);
    await openSection(page, 'Personas');
    await page.getByRole('button', { name: 'New Persona' }).click();
    const dialog = page.getByRole('dialog', { name: 'New persona' });
    await dialog.locator('input[type="file"][accept="image/*"]').setInputFiles({
      name: 'face.png', mimeType: 'image/png', buffer: Buffer.from('this is text'),
    });
    await expect(page.getByText('That file could not be read as an image.')).toBeVisible({ timeout: 10_000 });
    expect(mock.uploadedImages).toEqual([]);
  });

  test('a persona is deleted after I confirm, and not before', async ({ page, mock }) => {
    mock.addPersona({ name: 'Amadeus' });
    await login(page);
    await openSection(page, 'Personas');

    const card = page.getByRole('group', { name: 'Amadeus' });
    await card.getByRole('button', { name: 'Delete' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete Amadeus?' });
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    expect(mock.getPersonas().map((p) => p.name)).toContain('Amadeus');

    await card.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('dialog', { name: 'Delete Amadeus?' }).getByRole('button', { name: 'Delete persona' }).click();
    await expect(page.getByRole('group', { name: 'Amadeus' })).toHaveCount(0);
    expect(mock.getPersonas().map((p) => p.name)).toEqual(['Kurisu']);
  });
});

test.describe('skills', () => {
  test('a skill is made, changed and deleted, each on the server', async ({ page, mock }) => {
    await login(page);
    await openSection(page, 'Skills');
    const skills = async () => (await (await fetch(`${mock.url}/skills`)).json()) as Array<{ id: number; name: string; instructions: string }>;

    await page.getByRole('button', { name: 'Create Your First Skill' }).click();
    let dialog = page.getByRole('dialog', { name: 'New Skill' });
    await dialog.getByLabel('Skill Name').fill('Haiku');
    await dialog.getByLabel('Instructions').fill('Answer in a haiku.');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Haiku', { exact: true })).toBeVisible();
    expect(await skills()).toEqual([expect.objectContaining({ name: 'Haiku', instructions: 'Answer in a haiku.' })]);

    await page.getByTitle('Edit').click();
    dialog = page.getByRole('dialog', { name: 'Edit Skill' });
    await expect(dialog.getByLabel('Instructions')).toHaveValue('Answer in a haiku.');
    await dialog.getByLabel('Instructions').fill('Answer in a haiku, about cats.');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await skills())[0]?.instructions).toBe('Answer in a haiku, about cats.');

    await page.getByTitle('Delete').click();
    await expect(page.getByText('Haiku', { exact: true })).toHaveCount(0);
    await expect.poll(async () => (await skills()).length).toBe(0);
  });
});

test.describe('the assistant\'s settings', () => {
  test('changes are saved together, and only what changed is sent', async ({ page, mock }) => {
    await login(page);
    await openSection(page, 'Assistant');

    const wakeWord = page.getByLabel('Wake word');
    await expect(wakeWord).toHaveValue('kurisu');
    await wakeWord.fill('Christina');
    await page.getByLabel('Extended thinking').click();
    await page.getByLabel('Memory notes').fill('Likes Dr Pepper.');

    const patch = page.waitForRequest((r) => r.method() === 'PATCH' && new URL(r.url()).pathname === '/assistant');
    await page.getByRole('button', { name: 'Save' }).click();
    expect((await patch).postDataJSON()).toEqual({ think: true, memory: 'Likes Dr Pepper.', trigger_word: 'Christina' });
    await expect(page.getByText('Assistant saved.')).toBeVisible();
    expect(mock.getAssistant()).toMatchObject({ trigger_word: 'Christina', think: true, memory: 'Likes Dr Pepper.' });

    // Nothing changed now, so Save has nothing to send.
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  test('an emptied wake word is saved as none', async ({ page, mock }) => {
    await login(page);
    await openSection(page, 'Assistant');
    await page.getByLabel('Wake word').fill('');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Assistant saved.')).toBeVisible();
    expect(mock.getAssistant().trigger_word).toBeNull();
  });
});
