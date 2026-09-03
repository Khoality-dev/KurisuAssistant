import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api/client', () => ({
  apiClient: {
    deleteConversation: vi.fn(async (_id: number) => {}),
    getConversation: vi.fn(),
  },
}));

import { apiClient } from '../api/client';
import { useConversationStore } from './conversationStore';
import type { Message, ConversationDetail } from '../api/types';

describe('conversationStore.deleteConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConversationStore.setState({
      currentConversation: { id: 7, title: 'doomed', main_agent_id: 1, message_count: 0, created_at: '', updated_at: '' },
      messages: [{ id: 1, role: 'user', content: 'hi' } as any],
      totalMessages: 5,
      hasMoreMessages: true,
      messagesOffset: 5,
      isLoadingMessages: false,
      compactedUpToId: 100,
      compactedContext: 'previous summary',
      systemPromptTokenCount: 0,
    } as any);
  });

  it('hits the API to delete and resets the store', async () => {
    await useConversationStore.getState().deleteConversation(7);

    expect(apiClient.deleteConversation).toHaveBeenCalledWith(7);

    const s = useConversationStore.getState();
    expect(s.currentConversation).toBeNull();
    expect(s.messages).toEqual([]);
    expect(s.totalMessages).toBe(0);
    expect(s.hasMoreMessages).toBe(false);
    expect(s.messagesOffset).toBe(0);
  });

  it('clears the compacted-context state so the post-compact banner does not stick around', async () => {
    await useConversationStore.getState().deleteConversation(7);

    const s = useConversationStore.getState();
    expect(s.compactedUpToId).toBe(0);
    expect(s.compactedContext).toBe('');
  });
});

const baseDetail = (messages: Message[]): ConversationDetail => ({
  id: 1,
  title: 't',
  main_agent_id: null,
  created_at: '',
  messages,
  total_messages: messages.length,
  offset: 0,
  limit: 20,
  has_more: false,
  compacted_up_to_id: 0,
  compacted_context: '',
  system_prompt_token_count: 0,
});

describe('conversationStore.loadConversation — _clientKey carry-over', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConversationStore.setState({
      currentConversation: null,
      messages: [],
      totalMessages: 0,
      hasMoreMessages: false,
      messagesOffset: 0,
      isLoadingMessages: false,
      compactedUpToId: 0,
      compactedContext: '',
      systemPromptTokenCount: 0,
    });
  });

  it('preserves _clientKey on already-id\'d messages by id', async () => {
    useConversationStore.setState({
      messages: [
        { id: 1, role: 'user', content: 'hi', _clientKey: 'k-1' },
        { id: 2, role: 'assistant', content: 'hello', _clientKey: 'k-2' },
      ],
    });
    (apiClient.getConversation as any).mockResolvedValueOnce(
      baseDetail([
        { id: 1, role: 'user', content: 'hi' },
        { id: 2, role: 'assistant', content: 'hello' },
      ]),
    );

    await useConversationStore.getState().loadConversation(1);

    const msgs = useConversationStore.getState().messages;
    expect(msgs.map((m) => m._clientKey)).toEqual(['k-1', 'k-2']);
  });

  it('carries _clientKey from the unidentified tail onto newly id\'d messages by tail position', async () => {
    // Simulates the post-stream state: two old persisted messages plus
    // two just-streamed messages that are in the store without ids yet.
    useConversationStore.setState({
      messages: [
        { id: 10, role: 'user', content: 'old user' },
        { id: 11, role: 'assistant', content: 'old asst' },
        { role: 'user', content: 'new user', _clientKey: 'stream-user' },
        { role: 'assistant', content: 'new asst', _clientKey: 'stream-asst' },
      ],
    });
    (apiClient.getConversation as any).mockResolvedValueOnce(
      baseDetail([
        { id: 10, role: 'user', content: 'old user' },
        { id: 11, role: 'assistant', content: 'old asst' },
        { id: 12, role: 'user', content: 'new user' },
        { id: 13, role: 'assistant', content: 'new asst' },
      ]),
    );

    await useConversationStore.getState().loadConversation(1);

    const msgs = useConversationStore.getState().messages;
    expect(msgs[0]._clientKey).toBeUndefined();
    expect(msgs[1]._clientKey).toBeUndefined();
    expect(msgs[2]).toMatchObject({ id: 12, _clientKey: 'stream-user' });
    expect(msgs[3]).toMatchObject({ id: 13, _clientKey: 'stream-asst' });
  });

  it('handles the mixed case: some old keys preserved by id, some new ids matched by tail position', async () => {
    useConversationStore.setState({
      messages: [
        { id: 5, role: 'user', content: 'old', _clientKey: 'old-key' },
        { role: 'assistant', content: 'streamed', _clientKey: 'stream-key' },
      ],
    });
    (apiClient.getConversation as any).mockResolvedValueOnce(
      baseDetail([
        { id: 5, role: 'user', content: 'old' },
        { id: 6, role: 'assistant', content: 'streamed' },
      ]),
    );

    await useConversationStore.getState().loadConversation(1);

    const msgs = useConversationStore.getState().messages;
    expect(msgs[0]).toMatchObject({ id: 5, _clientKey: 'old-key' });
    expect(msgs[1]).toMatchObject({ id: 6, _clientKey: 'stream-key' });
  });

  it('leaves messages without prior keys unmodified', async () => {
    useConversationStore.setState({ messages: [] });
    (apiClient.getConversation as any).mockResolvedValueOnce(
      baseDetail([
        { id: 1, role: 'user', content: 'fresh load' },
      ]),
    );

    await useConversationStore.getState().loadConversation(1);

    const msgs = useConversationStore.getState().messages;
    expect(msgs[0]._clientKey).toBeUndefined();
  });

  it('does not crash when the new server payload has fewer unidentified messages than the old store tail', async () => {
    useConversationStore.setState({
      messages: [
        { role: 'user', content: 'a', _clientKey: 'ka' },
        { role: 'assistant', content: 'b', _clientKey: 'kb' },
      ],
    });
    (apiClient.getConversation as any).mockResolvedValueOnce(
      baseDetail([
        { id: 100, role: 'assistant', content: 'b' },
      ]),
    );

    await useConversationStore.getState().loadConversation(1);

    const msgs = useConversationStore.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]._clientKey).toBe('ka');
  });
});
