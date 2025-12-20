import { create } from 'zustand';
import { apiClient } from '../api/client';
import type { Conversation, Message } from '../api/types';

interface ConversationState {
  conversations: Conversation[];
  currentConversation: Conversation | null;
  messages: Message[];
  models: string[];
  selectedModel: string;

  // Pagination state
  totalMessages: number;
  hasMoreMessages: boolean;
  messagesOffset: number;
  isLoadingMessages: boolean;

  loadConversations: () => Promise<void>;
  loadConversation: (id: number) => Promise<void>;
  loadMoreMessages: () => Promise<void>;
  deleteConversation: (id: number) => Promise<void>;
  createNewConversation: () => void;
  loadModels: () => Promise<void>;
  setSelectedModel: (model: string) => void;
  addMessage: (message: Message) => void;
  updateLastMessage: (content: string) => void;
  setCurrentConversationId: (id: number) => void;
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: [],
  currentConversation: null,
  messages: [],
  models: [],
  selectedModel: '',

  // Pagination state initialization
  totalMessages: 0,
  hasMoreMessages: false,
  messagesOffset: 0,
  isLoadingMessages: false,

  loadConversations: async () => {
    const conversations = await apiClient.getConversations();
    set({ conversations });
  },

  loadConversation: async (id: number) => {
    // Load the most recent page of messages (offset=0)
    const data = await apiClient.getConversation(id, 50, 0);
    const conversation = get().conversations.find((c) => c.id === id) || null;

    set({
      currentConversation: conversation,
      messages: data.messages,
      totalMessages: data.total_messages,
      hasMoreMessages: data.has_more,
      messagesOffset: data.limit, // Next offset for loading more
      isLoadingMessages: false,
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
        50,
        messagesOffset
      );

      // Prepend older messages to the beginning
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
    const conversations = get().conversations.filter((c) => c.id !== id);
    set({ conversations, currentConversation: null, messages: [] });
  },

  createNewConversation: () => {
    set({
      currentConversation: null,
      messages: [],
      totalMessages: 0,
      hasMoreMessages: false,
      messagesOffset: 0,
      isLoadingMessages: false,
    });
  },

  loadModels: async () => {
    const models = await apiClient.getModels();
    set({ models, selectedModel: models[0] || '' });
  },

  setSelectedModel: (model: string) => {
    set({ selectedModel: model });
  },

  addMessage: (message: Message) => {
    set((state) => ({ messages: [...state.messages, message] }));
  },

  updateLastMessage: (content: string) => {
    set((state) => {
      const messages = [...state.messages];
      if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        messages[messages.length - 1] = { ...lastMessage, content };
      }
      return { messages };
    });
  },

  setCurrentConversationId: (id: number) => {
    const conversation = get().conversations.find((c) => c.id === id) || null;
    set({ currentConversation: conversation });
  },
}));
