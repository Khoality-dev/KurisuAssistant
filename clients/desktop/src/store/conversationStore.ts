import { create } from 'zustand';
import { apiClient } from '../api/client';
import type { Conversation, FrameInfo, Message } from '../api/types';

interface ConversationState {
  currentConversation: Conversation | null;
  messages: Message[];
  frames: Record<number, FrameInfo>;

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
  updateLastMessage: (content: string, thinking?: string, role?: string, name?: string) => void;
  setCurrentConversationId: (id: number) => void;
  updateCompactionData: (compactedUpToId: number, compactedContext: string) => void;
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  currentConversation: null,
  messages: [],
  frames: {},

  // Pagination state initialization
  totalMessages: 0,
  hasMoreMessages: false,
  messagesOffset: 0,
  isLoadingMessages: false,

  // Context window data
  compactedUpToId: 0,
  compactedContext: '',
  systemPromptTokenCount: 0,

  loadConversation: async (id: number) => {
    const data = await apiClient.getConversation(id, 20, 0);

    set({
      currentConversation: { id, title: data.title, frame_count: 0, created_at: data.created_at, updated_at: '' },
      messages: data.messages,
      frames: data.frames || {},
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

    // Don't load if already loading or no more messages
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

      // Prepend older messages to the beginning, merge frames
      set((state) => ({
        messages: [...data.messages, ...state.messages],
        frames: { ...state.frames, ...(data.frames || {}) },
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
    set({ currentConversation: null, messages: [], frames: {} });
  },

  clearCurrentConversation: () => {
    set({
      currentConversation: null,
      messages: [],
      frames: {},
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
    set({ currentConversation: { id, title: '', frame_count: 0, created_at: '', updated_at: '' } });
  },

  updateCompactionData: (compactedUpToId: number, compactedContext: string) => {
    set({ compactedUpToId, compactedContext });
  },
}));
