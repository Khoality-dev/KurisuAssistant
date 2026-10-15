import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Signing in opens the conversation the account touched last, whichever
 * persona answered it: a conversation is not tied to a persona any more
 * (#354), so there is no per-persona "last conversation" to look up.
 *
 * Opening it is a server round trip, and the user can send before it comes
 * back (#321). On a slow machine the first reply's chunk started a
 * conversation, then the lookup answered and replaced or cleared it: the first
 * message vanished from the chat and the next one opened a new conversation.
 * Whatever the lookup finds, it must not undo a conversation that started
 * while it was on its way.
 */

let answerList: (conversations: unknown[]) => void = () => {};

vi.mock('@kurisu/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kurisu/api')>()),
  apiClient: {
    listPersonas: vi.fn(async () => [{ id: 1, name: 'Kurisu' }]),
    getAssistant: vi.fn(async () => ({ selected_persona_id: 1 })),
    updateAssistant: vi.fn(async () => ({ selected_persona_id: null })),
    getConversations: vi.fn(() => new Promise((resolve) => { answerList = resolve; })),
    getConversation: vi.fn(async (id: number) => ({
      id, title: 'old', messages: [], total_messages: 0, has_more: false,
      created_at: '', updated_at: '',
    })),
    patchConversation: vi.fn(),
  },
}));

import { apiClient } from '@kurisu/api';
import { useConversationStore } from './conversationStore';
import { usePersonaStore } from './personaStore';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const listed = (id: number) => ({ id, title: `#${id}`, message_count: 3, created_at: '', updated_at: '' });

describe('personaStore: opening the latest conversation (#321, #354)', () => {
  beforeEach(() => {
    localStorage.clear();
    usePersonaStore.setState({ selectedPersonaId: 1 });
    useConversationStore.getState().clearCurrentConversation();
    vi.mocked(apiClient.getConversation).mockClear();
    vi.mocked(apiClient.getConversations).mockClear();
    vi.mocked(apiClient.patchConversation).mockClear();
  });

  it('reloading the personas leaves the open conversation alone', async () => {
    // Settings → Personas reloads them after every edit; that must not move the chat.
    useConversationStore.getState().setCurrentConversationId(42);
    await usePersonaStore.getState().loadPersonas();
    expect(apiClient.getConversations).not.toHaveBeenCalled();
    expect(useConversationStore.getState().currentConversation?.id).toBe(42);
  });

  it('opens the newest conversation the server lists, whoever answered it', async () => {
    const loading = usePersonaStore.getState().openLatestConversation();
    await flush();
    answerList([listed(7), listed(3)]);
    await loading;

    expect(useConversationStore.getState().currentConversation?.id).toBe(7);
  });

  it('with no conversations at all, opens none', async () => {
    const loading = usePersonaStore.getState().openLatestConversation();
    await flush();
    answerList([]);
    await loading;

    expect(useConversationStore.getState().currentConversation).toBeNull();
  });

  it('an empty list that arrives after a conversation started leaves that conversation alone', async () => {
    const loading = usePersonaStore.getState().openLatestConversation();
    await flush();
    useConversationStore.getState().setCurrentConversationId(42);

    answerList([]);
    await loading;

    expect(useConversationStore.getState().currentConversation?.id).toBe(42);
  });

  it('a conversation found late does not replace one that started meanwhile', async () => {
    const loading = usePersonaStore.getState().openLatestConversation();
    await flush();
    useConversationStore.getState().setCurrentConversationId(42);

    answerList([listed(7)]);
    await loading;

    expect(useConversationStore.getState().currentConversation?.id).toBe(42);
  });
});

describe('personaStore: switching persona is the account\'s (#354)', () => {
  beforeEach(() => {
    usePersonaStore.setState({ selectedPersonaId: 1 });
    vi.mocked(apiClient.getConversation).mockClear();
    vi.mocked(apiClient.patchConversation).mockClear();
    vi.mocked(apiClient.getConversations).mockClear();
  });

  it('keeps the open conversation open: it continues as the persona picked', async () => {
    useConversationStore.getState().setCurrentConversationId(42);

    usePersonaStore.getState().selectPersona(null);
    await flush();

    expect(apiClient.updateAssistant).toHaveBeenLastCalledWith({ selected_persona_id: null });
    expect(useConversationStore.getState().currentConversation?.id).toBe(42);
    expect(apiClient.patchConversation).not.toHaveBeenCalled();
    expect(apiClient.getConversation).not.toHaveBeenCalled();
    expect(apiClient.getConversations).not.toHaveBeenCalled();
  });
});

describe('personaStore: a switch the server refuses', () => {
  it('goes back to the persona that was in use, and says so to the caller', async () => {
    usePersonaStore.setState({ selectedPersonaId: 1 });
    vi.mocked(apiClient.updateAssistant).mockRejectedValueOnce(new Error('offline'));

    await expect(usePersonaStore.getState().selectPersona(null)).rejects.toThrow('offline');
    expect(usePersonaStore.getState().selectedPersonaId).toBe(1);
  });
});
