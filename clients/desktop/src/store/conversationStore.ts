import { create } from 'zustand';
import { apiClient } from '../api/client';
import type { Conversation, Message } from '../api/types';

interface ConversationState {
  currentConversation: Conversation | null;
  messages: Message[];

  // Pagination state
  totalMessages: number;
  hasMoreMessages: boolean;
  messagesOffset: number;
  isLoadingMessages: boolean;

  // Context window data
  compactedUpToId: number;
  compactedContext: string;
  systemPromptTokenCount: number;

  loadConversation: (id: number) => Promise<void>;
  loadMoreMessages: () => Promise<void>;
  deleteConversation: (id: number) => Promise<void>;
  clearCurrentConversation: () => void;
  addMessage: (message: Message) => void;
  appendMessages: (messages: Message[]) => void;
  updateLastMessage: (content: string, thinking?: string, role?: string, name?: string) => void;
  setCurrentConversationId: (id: number) => void;
  updateCompactionData: (compactedUpToId: number, compactedContext: string) => void;
}

const emptyConversation = (id: number, title = '', persona_id: number | null = null): Conversation => ({
  id,
  title,
  persona_id,
  message_count: 0,
  created_at: '',
  updated_at: '',
});

export const useConversationStore = create<ConversationState>((set, get) => ({
  currentConversation: null,
  messages: [],

  totalMessages: 0,
  hasMoreMessages: false,
  messagesOffset: 0,
  isLoadingMessages: false,

  compactedUpToId: 0,
  compactedContext: '',
  systemPromptTokenCount: 0,

  loadConversation: async (id: number) => {
    const data = await apiClient.getConversation(id, 20, 0);

    // Carry over _clientKey from the previous in-store messages so that
    // recently-streamed bubbles keep their React identity across the reload.
    // Match strategy: by id when the id was already present in prev; otherwise
    // by tail position among messages whose id is *new* in this payload — that
    // is the just-streamed tail picking up its DB ids.
    const prev = get().messages;
    const prevById = new Map<number, string>();
    const prevIdSet = new Set<number>();
    const prevUnidentifiedKeys: string[] = [];
    for (const m of prev) {
      if (m.id != null) {
        prevIdSet.add(m.id);
        if (m._clientKey) prevById.set(m.id, m._clientKey);
      } else if (m._clientKey) {
        prevUnidentifiedKeys.push(m._clientKey);
      }
    }
    const trulyNewIdxs: number[] = [];
    data.messages.forEach((m, i) => {
      if (m.id == null || !prevIdSet.has(m.id)) trulyNewIdxs.push(i);
    });
    const messages = data.messages.map((m, i) => {
      if (m.id != null) {
        const k = prevById.get(m.id);
        if (k) return { ...m, _clientKey: k };
      }
      const tailPos = trulyNewIdxs.indexOf(i);
      if (tailPos !== -1 && tailPos < prevUnidentifiedKeys.length) {
        return { ...m, _clientKey: prevUnidentifiedKeys[tailPos] };
      }
      return m;
    });

    set({
      currentConversation: {
        id,
        title: data.title,
        persona_id: data.persona_id,
        message_count: data.total_messages,
        created_at: data.created_at,
        updated_at: '',
      },
      messages,
      totalMessages: data.total_messages,
      hasMoreMessages: data.has_more,
      messagesOffset: data.limit,
      isLoadingMessages: false,
      compactedUpToId: data.compacted_up_to_id ?? 0,
      compactedContext: data.compacted_context ?? '',
      systemPromptTokenCount: data.system_prompt_token_count ?? 0,
    });
  },

  loadMoreMessages: async () => {
    const { currentConversation, messagesOffset, isLoadingMessages, hasMoreMessages } = get();

    if (isLoadingMessages || !hasMoreMessages || !currentConversation) {
      return;
    }

    set({ isLoadingMessages: true });

    try {
      const data = await apiClient.getConversation(
        currentConversation.id,
        20,
        messagesOffset
      );

      set((state) => ({
        messages: [...data.messages, ...state.messages],
        hasMoreMessages: data.has_more,
        messagesOffset: state.messagesOffset + data.messages.length,
        isLoadingMessages: false,
      }));
    } catch (error) {
      console.error('Error loading more messages:', error);
      set({ isLoadingMessages: false });
    }
  },

  deleteConversation: async (id: number) => {
    await apiClient.deleteConversation(id);
    set({
      currentConversation: null,
      messages: [],
      totalMessages: 0,
      hasMoreMessages: false,
      messagesOffset: 0,
      compactedUpToId: 0,
      compactedContext: '',
    });
  },

  clearCurrentConversation: () => {
    set({
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
  },

  addMessage: (message: Message) => {
    set((state) => ({ messages: [...state.messages, message] }));
  },

  appendMessages: (newMessages: Message[]) => {
    set((state) => ({ messages: [...state.messages, ...newMessages] }));
  },

  updateLastMessage: (content: string, thinking?: string, role?: string, name?: string) => {
    set((state) => {
      const messages = [...state.messages];
      if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        messages[messages.length - 1] = {
          ...lastMessage,
          content,
          ...(thinking !== undefined ? { thinking } : {}),
          ...(role !== undefined ? { role } : {}),
          ...(name !== undefined ? { name } : {}),
        };
      }
      return { messages };
    });
  },

  setCurrentConversationId: (id: number) => {
    set({ currentConversation: emptyConversation(id) });
  },

  updateCompactionData: (compactedUpToId: number, compactedContext: string) => {
    set({ compactedUpToId, compactedContext });
  },
}));
