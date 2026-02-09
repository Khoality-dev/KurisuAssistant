import { create } from 'zustand';
import { apiClient } from '../api/client';
import { storage } from '../utils/storage';
import type { Agent } from '../api/types';

const ADMINISTRATOR_NAME = 'Administrator';

interface AgentState {
  agents: Agent[];
  selectedAgentId: number | null;
  isLoading: boolean;
  loadAgents: () => Promise<void>;
  selectAgent: (id: number | null) => void;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: [],
  selectedAgentId: storage.getSelectedAgentId(),
  isLoading: false,

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
      if (!stillValid && agents.length > 0) {
        const firstId = agents[0].id;
        set({ selectedAgentId: firstId });
        storage.setSelectedAgentId(firstId);
      }
    } catch (err) {
      console.error('Failed to load agents:', err);
    } finally {
      set({ isLoading: false });
    }
  },

  selectAgent: (id: number | null) => {
    set({ selectedAgentId: id });
    if (id !== null) {
      storage.setSelectedAgentId(id);
    } else {
      storage.clearSelectedAgentId();
    }
  },
}));
