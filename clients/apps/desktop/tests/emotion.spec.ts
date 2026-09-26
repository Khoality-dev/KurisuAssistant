/**
 * When the persona's feeling reaches the character window (#244).
 *
 * The timing itself is pinned by the unit tests (`emotionTiming.test.ts`,
 * `segmentCues.test.ts`, `CharacterSurface.test.tsx`); this pins the wiring
 * they cannot reach — the streaming hook handing each chunk's cue to the
 * planner, the TTS queue carrying it into the segment, and the feed mirror
 * carrying it to the second window — by listening to what the main process
 * relays. No WebGL is needed: Kurisu is a 3D persona with no model, so the
 * window draws nothing and the messages are the whole of what is asserted.
 *
 * With speech on, the mock's `POST /tts` answers no audio, so each sentence
 * takes the queue's failure path: a silent 4 s segment that still carries its
 * feelings (`FAILED_SENTENCE_MS`), which is what this reads.
 */
import { test, expect } from './fixtures';
import type { ElectronApplication, Page } from '@playwright/test';
import { VRM_CHARACTER_WITH_MODEL } from './mock/server';

const REPLY = [
  { content: 'Hello there. ', role: 'assistant', delayMs: 20, emotion: 'happy' as const, emotionAt: 0 },
  { content: 'Goodbye.', role: 'assistant', delayMs: 20, emotion: 'sad' as const, emotionAt: 13 },
];

async function login(page: Page) {
  await page.getByLabel('Username').fill('tester');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  const composer = page.getByPlaceholder('Type your message...');
  await expect(composer).toBeVisible({ timeout: 15_000 });
  return composer;
}

/** Record what the main process relays to the character window on two channels. */
async function listen(electronApp: ElectronApplication) {
  await electronApp.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __relayed: Array<{ channel: string; data: unknown }> };
    g.__relayed = [];
    for (const channel of ['character:feed', 'character:speech']) {
      ipcMain.on(channel, (_event, data) => g.__relayed.push({ channel, data }));
    }
  });
  return (channel: string) => electronApp.evaluate(
    (_electron, name) => (globalThis as unknown as { __relayed: Array<{ channel: string; data: unknown }> })
      .__relayed.filter((m) => m.channel === name).map((m) => m.data),
    channel,
  );
}

/** The chat header shows the inline panel; the panel pops out into the window (#241). */
async function openCharacterWindow(page: Page, electronApp: ElectronApplication) {
  await page.getByRole('button', { name: 'Show character' }).click();
  await Promise.all([
    electronApp.waitForEvent('window'),
    page.getByRole('button', { name: 'Pop out character' }).click(),
  ]);
  await expect(page.getByText('Showing in its own window')).toBeVisible();
}

test.describe('the persona\'s feeling reaches the character window', () => {
  test.beforeEach(({ mock }) => {
    mock.setCharacterConfig(1, { kind: 'vrm', vrm: { ...VRM_CHARACTER_WITH_MODEL.vrm!, model: null } });
    mock.setStream({ chunks: REPLY });
  });

  test('with speech on, the feelings ride the spoken sentence, at their place in it', async ({ page, electronApp }) => {
    const composer = await login(page);
    const relayed = await listen(electronApp);
    await openCharacterWindow(page, electronApp);

    await composer.fill('Hi');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Goodbye.').first()).toBeVisible({ timeout: 15_000 });

    // "Hello there." is two words, short of a group, so the whole reply is
    // spoken as one: the sad cue at offset 13 of 21 lands 13/21 of the way in.
    await expect.poll(async () => (await relayed('character:speech')).filter(Boolean).length, { timeout: 15_000 }).toBeGreaterThan(0);
    const segments = (await relayed('character:speech')).filter(Boolean) as Array<{ text: string; durationMs: number; cues: Array<{ emotion: string; delayMs: number }> }>;
    expect(segments[0].text).toBe('Hello there. Goodbye.');
    expect(segments[0].cues.map((c) => c.emotion)).toEqual(['happy', 'sad']);
    expect(segments[0].cues[0].delayMs).toBe(0);
    expect(segments[0].cues[1].delayMs).toBeCloseTo(segments[0].durationMs * 13 / 21, 5);

    // Nothing was shown on text arrival: the feeling waits for the voice.
    const feeds = (await relayed('character:feed')) as Array<{ emotion?: unknown }>;
    expect(feeds.filter((f) => f.emotion)).toEqual([]);
  });

  test('with speech off, the feeling shows as its text arrives, the last of a quick run winning', async ({ page, electronApp }) => {
    await page.evaluate(() => localStorage.setItem('kurisu_tts_auto_play', 'false'));
    const composer = await login(page);
    const relayed = await listen(electronApp);
    await openCharacterWindow(page, electronApp);

    await composer.fill('Hi');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Goodbye.').first()).toBeVisible({ timeout: 15_000 });

    // One feeling per `at`. The window is marked open before it has loaded
    // (#241's pop-out), so a feeling pushed in that gap is forwarded once and
    // sent again by the `ready` catch-up — which is what keeps it from being
    // lost; the window applies both as one, since they carry the same `at`.
    const shown = async () => {
      const seen = new Map<number, { cue: unknown; personaId: number | null }>();
      for (const f of (await relayed('character:feed')) as Array<{ emotion?: { cue: unknown; personaId: number | null; at: number } }>) {
        if (f.emotion) seen.set(f.emotion.at, { cue: f.emotion.cue, personaId: f.emotion.personaId });
      }
      return [...seen.values()];
    };
    await expect.poll(shown, { timeout: 5_000 }).toEqual([{ cue: { emotion: 'sad', hold_ms: 1500 }, personaId: 1 }]);
    expect((await relayed('character:speech')).filter(Boolean)).toEqual([]);
  });
});
