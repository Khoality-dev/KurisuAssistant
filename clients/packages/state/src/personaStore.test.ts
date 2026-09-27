import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Opening a persona's last conversation is a server round trip, and the user
 * can send before it comes back (#321). On a slow machine the first reply's
 * chunk started a conversation, then the lookup answered "none yet" and cleared
 * it: the first message vanished from the chat and the next one opened a new
 * conversation. Whatever the lookup finds, it must not undo a conversation that
 * started while it was on its way.
 */

let answerLatest: (conv: unknown) => void = () => {};

vi.mock('@kurisu/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kurisu/api')>()),
  apiClient: {
    listPersonas: vi.fn(async () => [{ id: 1, name: 'Kurisu' }]),
    getLatestConversationForPersona: vi.fn(() => new Promise((resolve) => { answerLatest = resolve; })),
    getLatestAssistantConversation: vi.fn(() => new Promise((resolve) => { answerLatest = resolve; })),
    getConversation: vi.fn(async (id: number) => ({
      id, title: 'old', persona_id: 1, messages: [], total_messages: 0, has_more: false,
      created_at: '', updated_at: '',
    })),
    getConversations: vi.fn(async () => []),
  },
}));

import { storage } from '@kurisu/api';
import { useConversationStore } from './conversationStore';
import { usePersonaStore } from './personaStore';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('personaStore: opening the last conversation (#321)', () => {
  beforeEach(() => {
    localStorage.clear();
    storage.setSelectedPersonaId(1);
    usePersonaStore.setState({ selectedPersonaId: 1 });
    useConversationStore.getState().clearCurrentConversation();
  });

  it('a "none yet" that arrives after a conversation started leaves that conversation alone', async () => {
    const loading = usePersonaStore.getState().loadPersonas();
    await flush();

    // The first reply's first chunk: the server named the new conversation.
    useConversationStore.getState().setCurrentConversationId(42);

    answerLatest(null);
    await loading;

    expect(useConversationStore.getState().currentConversation?.id).toBe(42);
  });

  it('a conversation found late does not replace one that started meanwhile', async () => {
    const loading = usePersonaStore.getState().loadPersonas();
    await flush();
    useConversationStore.getState().setCurrentConversationId(42);

    answerLatest({ id: 7, title: 'older', persona_id: 1, message_count: 3, created_at: '', updated_at: '' });
    await loading;

    expect(useConversationStore.getState().currentConversation?.id).toBe(42);
  });

  it('with nothing started meanwhile, the last conversation still opens', async () => {
    const loading = usePersonaStore.getState().loadPersonas();
    await flush();
    answerLatest({ id: 7, title: 'older', persona_id: 1, message_count: 3, created_at: '', updated_at: '' });
    await loading;

    expect(useConversationStore.getState().currentConversation?.id).toBe(7);
  });
});
