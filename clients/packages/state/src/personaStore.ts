import { create } from 'zustand';
import { apiClient } from '@kurisu/api';
import { storage } from '@kurisu/api';
import type { PersonaConversationKey } from '@kurisu/api';
import { useConversationStore } from './conversationStore';
import type { Persona, ConversationLastMessage } from '@kurisu/models';

export interface PersonaPreview {
  conversationId: number;
  lastMessage: ConversationLastMessage | null;
}

interface PersonaState {
  personas: Persona[];
  /**
   * Who the user has chosen to talk to, or null for the assistant itself. A
   * persona is optional (#302): null is a choice, not a gap to fill, so it is
   * never replaced by "the first persona" — a new chat then sends no persona
   * and the server's default (or the assistant) answers.
   */
  selectedPersonaId: number | null;
  isLoading: boolean;
  personaPreviews: Record<number, PersonaPreview>;
  /** The preview for the assistant's own conversation (the `'unbound'` bucket). */
  assistantPreview: PersonaPreview | null;
  loadPersonas: () => Promise<void>;
  selectPersona: (id: number | null) => void;
  loadPersonaPreviews: () => Promise<void>;
}

/** The bucket a selection keeps its current conversation under. */
const bucketOf = (id: number | null): PersonaConversationKey => id ?? 'unbound';

/**
 * Open the conversation this selection was last on: the one remembered locally,
 * else the latest the server has for it, else none.
 */
async function openBucket(id: number | null): Promise<void> {
  const key = bucketOf(id);
  const convStore = useConversationStore.getState();
  const convId = storage.getPersonaConversationId(key);
  if (convId) {
    try {
      await convStore.loadConversation(convId);
    } catch {
      storage.clearPersonaConversationId(key);
      convStore.clearCurrentConversation();
    }
    return;
  }
  try {
    const conv = id === null
      ? await apiClient.getLatestAssistantConversation()
      : await apiClient.getLatestConversationForPersona(id);
    if (conv) {
      storage.setPersonaConversationId(key, conv.id);
      await convStore.loadConversation(conv.id);
    } else {
      convStore.clearCurrentConversation();
    }
  } catch {
    convStore.clearCurrentConversation();
  }
}

export const usePersonaStore = create<PersonaState>((set, get) => ({
  personas: [],
  selectedPersonaId: storage.getSelectedPersonaId(),
  isLoading: false,
  personaPreviews: {},
  assistantPreview: null,

  loadPersonas: async () => {
    try {
      set({ isLoading: true });
      // Every persona the user owns is selectable. There is no agent_type to
      // filter on any more: sub-agents are a separate resource that never speaks.
      const personas = await apiClient.listPersonas();
      set({ personas });

      // A remembered persona that is gone falls back to the assistant, never to
      // another persona the user did not pick.
      const { selectedPersonaId } = get();
      const stillValid = selectedPersonaId !== null && personas.some((p) => p.id === selectedPersonaId);
      const finalId = stillValid ? selectedPersonaId : null;
      if (!stillValid && selectedPersonaId !== null) {
        set({ selectedPersonaId: null });
        storage.clearSelectedPersonaId();
      }

      await openBucket(finalId);
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
      const previewOf = (key: PersonaConversationKey): PersonaPreview | null => {
        const convId = storage.getPersonaConversationId(key);
        const conv = convId ? conversations.find((c) => c.id === convId) : undefined;
        return conv ? { conversationId: conv.id, lastMessage: conv.last_message ?? null } : null;
      };

      const previews: Record<number, PersonaPreview> = {};
      for (const persona of personas) {
        const preview = previewOf(persona.id);
        if (preview) previews[persona.id] = preview;
      }

      set({ personaPreviews: previews, assistantPreview: previewOf('unbound') });
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
    // Load the conversation for this persona, or the assistant's own.
    void openBucket(id);
  },
}));
