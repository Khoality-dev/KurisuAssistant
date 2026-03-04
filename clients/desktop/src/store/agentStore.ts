import { create } from 'zustand';
import { apiClient } from '../api/client';
import { storage } from '../utils/storage';
import { useConversationStore } from './conversationStore';
import type { Agent, ConversationLastMessage } from '../api/types';

const ADMINISTRATOR_NAME = 'Administrator';

export interface AgentPreview {
  conversationId: number;
  lastMessage: ConversationLastMessage | null;
}

interface AgentState {
  agents: Agent[];
  selectedAgentId: number | null;
  isLoading: boolean;
  agentPreviews: Record<number, AgentPreview>;
  loadAgents: () => Promise<void>;
  selectAgent: (id: number | null) => void;
  loadAgentPreviews: () => Promise<void>;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: [],
  selectedAgentId: storage.getSelectedAgentId(),
  isLoading: false,
  agentPreviews: {},

  loadAgents: async () => {
    try {
      set({ isLoading: true });
      const allAgents = await apiClient.listAgents();
      // Filter out Administrator for user-facing list
      const agents = allAgents.filter((a) => a.name !== ADMINISTRATOR_NAME);
      set({ agents });

      // Auto-select first agent if stored selection is invalid
      const { selectedAgentId } = get();
      const stillValid = selectedAgentId !== null && agents.some((a) => a.id === selectedAgentId);
      const finalId = stillValid ? selectedAgentId : (agents.length > 0 ? agents[0].id : null);

      if (!stillValid && finalId !== null) {
        set({ selectedAgentId: finalId });
        storage.setSelectedAgentId(finalId);
      }

      // Load conversation for the selected agent
      if (finalId !== null) {
        const convStore = useConversationStore.getState();
        const convId = storage.getAgentConversationId(finalId);
        if (convId) {
          try {
            await convStore.loadConversation(convId);
          } catch {
            storage.clearAgentConversationId(finalId);
            convStore.clearCurrentConversation();
          }
        } else {
          // Fallback: query backend for the latest conversation with this agent
          try {
            const conv = await apiClient.getLatestConversationForAgent(finalId);
            if (conv) {
              storage.setAgentConversationId(finalId, conv.id);
              await convStore.loadConversation(conv.id);
            } else {
              convStore.clearCurrentConversation();
            }
          } catch {
            convStore.clearCurrentConversation();
          }
        }
      }
      // Load preview data for sidebar
      get().loadAgentPreviews();
    } catch (err) {
      console.error('Failed to load agents:', err);
    } finally {
      set({ isLoading: false });
    }
  },

  loadAgentPreviews: async () => {
    try {
      const conversations = await apiClient.getConversations();
      const { agents } = get();
      const previews: Record<number, AgentPreview> = {};

      for (const agent of agents) {
        const convId = storage.getAgentConversationId(agent.id);
        if (convId) {
          const conv = conversations.find((c) => c.id === convId);
          if (conv) {
            previews[agent.id] = {
              conversationId: conv.id,
              lastMessage: conv.last_message ?? null,
            };
          }
        }
      }

      set({ agentPreviews: previews });
    } catch (err) {
      console.error('Failed to load agent previews:', err);
    }
  },

  selectAgent: (id: number | null) => {
    set({ selectedAgentId: id });
    if (id !== null) {
      storage.setSelectedAgentId(id);
    } else {
      storage.clearSelectedAgentId();
    }

    // Load the conversation for this agent
    const convStore = useConversationStore.getState();
    if (id !== null) {
      const convId = storage.getAgentConversationId(id);
      if (convId) {
        convStore.loadConversation(convId).catch(() => {
          storage.clearAgentConversationId(id);
          convStore.clearCurrentConversation();
        });
      } else {
        // Fallback: query backend for the latest conversation with this agent
        apiClient.getLatestConversationForAgent(id).then((conv) => {
          if (conv) {
            storage.setAgentConversationId(id, conv.id);
            convStore.loadConversation(conv.id).catch(() => {
              storage.clearAgentConversationId(id);
              convStore.clearCurrentConversation();
            });
          } else {
            convStore.clearCurrentConversation();
          }
        }).catch(() => {
          convStore.clearCurrentConversation();
        });
      }
    } else {
      convStore.clearCurrentConversation();
    }
  },
}));
