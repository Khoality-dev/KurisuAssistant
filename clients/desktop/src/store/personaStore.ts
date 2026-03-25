import { create } from 'zustand';
import { apiClient } from '../api/client';
import type { Persona } from '../api/types';

interface PersonaState {
  personas: Persona[];
  isLoading: boolean;
  loadPersonas: () => Promise<void>;
}

export const usePersonaStore = create<PersonaState>((set) => ({
  personas: [],
  isLoading: false,
  loadPersonas: async () => {
    set({ isLoading: true });
    try {
      const personas = await apiClient.listPersonas();
      set({ personas, isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },
}));
