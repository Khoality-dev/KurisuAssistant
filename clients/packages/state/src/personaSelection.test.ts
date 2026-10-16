import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The persona in use is kept on the server, for the whole account (#334, #354):
 * a sign-in elsewhere — or here again after a sign-out — opens on it, and every
 * turn in every conversation answers as it. The client reads it and saves a
 * pick; it never names a persona on a chat request.
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
    getConversations: vi.fn(async () => []),
  },
}));

import { apiClient } from '@kurisu/api';
import * as personaStoreModule from './personaStore';
import { usePersonaStore } from './personaStore';

beforeEach(() => {
  localStorage.clear();
  assistant.selected_persona_id = 2;
  usePersonaStore.setState({ selectedPersonaId: null, selectionLoaded: false });
  vi.mocked(apiClient.updateAssistant).mockClear();
});

describe('the persona in use (#334, #354)', () => {
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

  it('keeps nothing per persona on this machine', async () => {
    await usePersonaStore.getState().loadPersonas();
    usePersonaStore.getState().selectPersona(1);
    expect(localStorage.getItem('kurisu_persona_conversations')).toBeNull();
    expect('whenSelectionLoaded' in personaStoreModule).toBe(false);
    expect('personaPreviews' in usePersonaStore.getState()).toBe(false);
  });
});

describe('a pick made while the personas are loading (#364)', () => {
  it('is not undone by the load that started before it', async () => {
    // The load reads the server before the pick is saved, and answers after.
    let answer!: () => void;
    vi.mocked(apiClient.getAssistant).mockImplementationOnce(() => {
      const before = { ...assistant };
      return new Promise((resolve) => { answer = () => resolve(before as never); });
    });
    const loading = usePersonaStore.getState().loadPersonas();
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));

    await usePersonaStore.getState().selectPersona(null);
    answer();
    await loading;

    expect(usePersonaStore.getState().selectedPersonaId).toBeNull();
    expect(usePersonaStore.getState().selectionLoaded).toBe(true);
  });

  it('a load that starts after the pick still reads the server', async () => {
    await usePersonaStore.getState().selectPersona(1);
    assistant.selected_persona_id = 2; // changed on another device
    await usePersonaStore.getState().loadPersonas();
    expect(usePersonaStore.getState().selectedPersonaId).toBe(2);
  });
});
