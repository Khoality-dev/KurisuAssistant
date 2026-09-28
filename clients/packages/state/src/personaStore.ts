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
   * and the assistant answers. Kept on the server as the assistant's
   * `selected_persona_id` (#334): read by `loadPersonas`, written by
   * `selectPersona`, so every device and every sign-in opens on the same one.
   */
  selectedPersonaId: number | null;
  /**
   * `selectedPersonaId` has come back from the server since sign-in. Until it
   * has, a null there means "not known yet", not "the assistant" (#334).
   */
  selectionLoaded: boolean;
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
 *
 * Every answer here is a round trip, and the user can send before it returns:
 * that send's first chunk starts a conversation. So nothing a lookup finds —
 * "none yet", an older conversation, or a failure — is applied once the chat
 * has moved on, or once another persona has been picked (#321). It used to
 * clear the conversation just started: the first message vanished from the
 * chat and the next one opened a new conversation.
 */
async function openBucket(id: number | null): Promise<void> {
  const key = bucketOf(id);
  const convStore = useConversationStore.getState();
  const startedOn = convStore.currentConversation?.id ?? null;
  const stillOurs = () =>
    (useConversationStore.getState().currentConversation?.id ?? null) === startedOn
    && bucketOf(usePersonaStore.getState().selectedPersonaId) === key;

  const convId = storage.getPersonaConversationId(key);
  if (convId) {
    try {
      await convStore.loadConversation(convId, { unlessChanged: true });
    } catch {
      if (!stillOurs()) return;
      storage.clearPersonaConversationId(key);
      convStore.clearCurrentConversation();
    }
    return;
  }
  try {
    const conv = id === null
      ? await apiClient.getLatestAssistantConversation()
      : await apiClient.getLatestConversationForPersona(id);
    if (!stillOurs()) return;
    if (conv) {
      storage.setPersonaConversationId(key, conv.id);
      await convStore.loadConversation(conv.id, { unlessChanged: true });
    } else {
      convStore.clearCurrentConversation();
    }
  } catch {
    if (stillOurs()) convStore.clearCurrentConversation();
  }
}

export const usePersonaStore = create<PersonaState>((set, get) => ({
  personas: [],
  selectedPersonaId: null,
  selectionLoaded: false,
  isLoading: false,
  personaPreviews: {},
  assistantPreview: null,

  loadPersonas: async () => {
    try {
      set({ isLoading: true });
      // Every persona the user owns is selectable. There is no agent_type to
      // filter on any more: sub-agents are a separate resource that never speaks.
      const [personas, assistant] = await Promise.all([apiClient.listPersonas(), apiClient.getAssistant()]);
      // The server clears a selection whose persona is disabled or deleted; one
      // missing from the list anyway still falls back to the assistant, never to
      // another persona the user did not pick.
      const selected = assistant.selected_persona_id;
      const finalId = selected !== null && personas.some((p) => p.id === selected) ? selected : null;
      set({ personas, selectedPersonaId: finalId, selectionLoaded: true });

      await openBucket(finalId);
      // Load preview data for sidebar
      get().loadPersonaPreviews();
    } catch (err) {
      console.error('Failed to load personas:', err);
    } finally {
      // A failed load still settles it, so a send waiting on it goes ahead —
      // to the assistant, as the header says — rather than hanging.
      set({ isLoading: false, selectionLoaded: true });
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
    // Kept on the server, so the next sign-in, here or elsewhere, opens on it.
    apiClient.updateAssistant({ selected_persona_id: id })
      .catch((err) => console.error('Failed to save who the chat is on:', err));
    // Load the conversation for this persona, or the assistant's own.
    void openBucket(id);
  },
}));

/**
 * Resolves once the selection has come back from the server, or after
 * `timeoutMs` whatever happens: a new chat's first message names the persona
 * the chat is on, and a quick send can beat the `GET /assistant` that says who
 * that is (#334). Windows CI did, and the assistant answered instead.
 */
export function whenSelectionLoaded(timeoutMs = 10_000): Promise<void> {
  if (usePersonaStore.getState().selectionLoaded) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); unsubscribe(); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    const unsubscribe = usePersonaStore.subscribe((s) => { if (s.selectionLoaded) done(); });
  });
}
