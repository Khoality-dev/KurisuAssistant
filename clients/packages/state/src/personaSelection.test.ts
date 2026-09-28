import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Who the chat is on is kept on the server (#334), not in this machine's local
 * storage: a sign-in elsewhere — or here again after a sign-out — opened on the
 * assistant whatever had been picked, and the server then answered as the old
 * default persona behind a header that said "Assistant".
 */

const assistant = { selected_persona_id: 2 as number | null };

vi.mock('@kurisu/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kurisu/api')>()),
  apiClient: {
    listPersonas: vi.fn(async () => [
      { id: 1, name: 'Kurisu', enabled: true },
      { id: 2, name: 'Amadeus', enabled: true },
    ]),
    getAssistant: vi.fn(async () => ({ ...assistant })),
    updateAssistant: vi.fn(async (update: { selected_persona_id: number | null }) => {
      assistant.selected_persona_id = update.selected_persona_id;
      return { ...assistant };
    }),
    getLatestConversationForPersona: vi.fn(async () => null),
    getLatestAssistantConversation: vi.fn(async () => null),
    getConversations: vi.fn(async () => []),
  },
}));

import { apiClient } from '@kurisu/api';
import { usePersonaStore, whenSelectionLoaded } from './personaStore';

beforeEach(() => {
  localStorage.clear();
  assistant.selected_persona_id = 2;
  usePersonaStore.setState({ selectedPersonaId: null, selectionLoaded: false });
  vi.mocked(apiClient.updateAssistant).mockClear();
});

describe('the chat selection (#334)', () => {
  it('opens on the persona the server has, with nothing stored on this machine', async () => {
    await usePersonaStore.getState().loadPersonas();
    expect(usePersonaStore.getState().selectedPersonaId).toBe(2);
  });

  it('opens on the assistant when the server has nobody selected', async () => {
    assistant.selected_persona_id = null;
    await usePersonaStore.getState().loadPersonas();
    expect(usePersonaStore.getState().selectedPersonaId).toBeNull();
  });

  it('saves a pick to the server, the assistant included', async () => {
    usePersonaStore.getState().selectPersona(1);
    expect(apiClient.updateAssistant).toHaveBeenLastCalledWith({ selected_persona_id: 1 });

    usePersonaStore.getState().selectPersona(null);
    expect(apiClient.updateAssistant).toHaveBeenLastCalledWith({ selected_persona_id: null });
  });

  it('a send waiting on the selection goes ahead once it has loaded', async () => {
    let settled = false;
    const waiting = whenSelectionLoaded().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await usePersonaStore.getState().loadPersonas();
    await waiting;
    expect(settled).toBe(true);
  });

  it('and never waits forever', async () => {
    vi.useFakeTimers();
    try {
      const waiting = whenSelectionLoaded(50);
      vi.advanceTimersByTime(50);
      await waiting;
    } finally {
      vi.useRealTimers();
    }
  });
});
