import { create } from 'zustand';
import { apiClient } from '../api/client';
import { storage } from '../utils/storage';
import { useConversationStore } from './conversationStore';
import type { Persona, ConversationLastMessage } from '../api/types';

export interface PersonaPreview {
  conversationId: number;
  lastMessage: ConversationLastMessage | null;
}

interface PersonaState {
  personas: Persona[];
  selectedPersonaId: number | null;
  isLoading: boolean;
  personaPreviews: Record<number, PersonaPreview>;
  loadPersonas: () => Promise<void>;
  selectPersona: (id: number | null) => void;
  loadPersonaPreviews: () => Promise<void>;
}

export const usePersonaStore = create<PersonaState>((set, get) => ({
  personas: [],
  selectedPersonaId: storage.getSelectedPersonaId(),
  isLoading: false,
  personaPreviews: {},

  loadPersonas: async () => {
    try {
      set({ isLoading: true });
      // Every persona the user owns is selectable. There is no agent_type to
      // filter on any more: sub-agents are a separate resource that never speaks.
      const personas = await apiClient.listPersonas();
      set({ personas });

      const { selectedPersonaId } = get();
      const stillValid = selectedPersonaId !== null && personas.some((p) => p.id === selectedPersonaId);
      const finalId = stillValid ? selectedPersonaId : (personas.length > 0 ? personas[0].id : null);

      if (!stillValid && finalId !== null) {
        set({ selectedPersonaId: finalId });
        storage.setSelectedPersonaId(finalId);
      }

      // Load conversation for the selected persona
      if (finalId !== null) {
        const convStore = useConversationStore.getState();
        const convId = storage.getPersonaConversationId(finalId);
        if (convId) {
          try {
            await convStore.loadConversation(convId);
          } catch {
            storage.clearPersonaConversationId(finalId);
            convStore.clearCurrentConversation();
          }
        } else {
          // Fallback: query backend for the latest conversation bound to this persona
          try {
            const conv = await apiClient.getLatestConversationForPersona(finalId);
            if (conv) {
              storage.setPersonaConversationId(finalId, conv.id);
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
      get().loadPersonaPreviews();
    } catch (err) {
      console.error('Failed to load personas:', err);
    } finally {
      set({ isLoading: false });
    }
  },

  loadPersonaPreviews: async () => {
    try {
      const conversations = await apiClient.getConversations();
      const { personas } = get();
      const previews: Record<number, PersonaPreview> = {};

      for (const persona of personas) {
        const convId = storage.getPersonaConversationId(persona.id);
        if (convId) {
          const conv = conversations.find((c) => c.id === convId);
          if (conv) {
            previews[persona.id] = {
              conversationId: conv.id,
              lastMessage: conv.last_message ?? null,
            };
          }
        }
      }

      set({ personaPreviews: previews });
    } catch (err) {
      console.error('Failed to load persona previews:', err);
    }
  },

  selectPersona: (id: number | null) => {
    set({ selectedPersonaId: id });
    if (id !== null) {
      storage.setSelectedPersonaId(id);
    } else {
      storage.clearSelectedPersonaId();
    }

    // Load the conversation for this persona
    const convStore = useConversationStore.getState();
    if (id !== null) {
      const convId = storage.getPersonaConversationId(id);
      if (convId) {
        convStore.loadConversation(convId).catch(() => {
          storage.clearPersonaConversationId(id);
          convStore.clearCurrentConversation();
        });
      } else {
        // Fallback: query backend for the latest conversation bound to this persona
        apiClient.getLatestConversationForPersona(id).then((conv) => {
          if (conv) {
            storage.setPersonaConversationId(id, conv.id);
            convStore.loadConversation(conv.id).catch(() => {
              storage.clearPersonaConversationId(id);
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
