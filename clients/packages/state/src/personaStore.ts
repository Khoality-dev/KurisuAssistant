import { create } from 'zustand';
import { apiClient } from '@kurisu/api';
import { useConversationStore } from './conversationStore';
import type { Persona } from '@kurisu/models';

interface PersonaState {
  personas: Persona[];
  /**
   * The persona in use for the whole account, or null for the assistant
   * itself (#302, #354). The server answers every turn, in every conversation,
   * as it — the client never names a persona on a chat request. Kept on the
   * server as the assistant's `selected_persona_id` (#334): read by
   * `loadPersonas`, written by `selectPersona`, so every device and every
   * sign-in agree.
   */
  selectedPersonaId: number | null;
  /**
   * `selectedPersonaId` has come back from the server since sign-in. Until it
   * has, a null there means "not known yet", not "the assistant" (#334).
   */
  selectionLoaded: boolean;
  isLoading: boolean;
  /** The personas and the one in use. Touches no conversation. */
  loadPersonas: () => Promise<void>;
  /**
   * Open the conversation the account touched last — on sign-in. Separate from
   * `loadPersonas`, which Settings → Personas calls after every edit and which
   * must not move the chat.
   */
  openLatestConversation: () => Promise<void>;
  /**
   * Put a persona in use for the whole account (null: the assistant itself).
   * The open conversation stays open and carries on as the new persona. A
   * save the server refuses puts the previous one back, and rejects.
   */
  selectPersona: (id: number | null) => Promise<void>;
}

/**
 * Open the conversation the account touched last, whichever persona answered
 * it — a conversation is not tied to a persona (#354) — or none.
 *
 * It is a round trip, and the user can send before it returns: that send's
 * first chunk starts a conversation. So nothing the lookup finds — an empty
 * list, an older conversation, or a failure — is applied once the chat has
 * moved on (#321). It used to clear the conversation just started: the first
 * message vanished from the chat and the next one opened a new conversation.
 */
async function openLatestConversation(): Promise<void> {
  const convStore = useConversationStore.getState();
  const startedOn = convStore.currentConversation?.id ?? null;
  const navigationsBefore = convStore.navigations;
  // Nothing moved meanwhile: no conversation started by a send, none opened,
  // and no New chat — which leaves the id where it was (#312).
  const stillOurs = () => {
    const now = useConversationStore.getState();
    return (now.currentConversation?.id ?? null) === startedOn && now.navigations === navigationsBefore;
  };

  try {
    const [latest] = await apiClient.getConversations(1);
    if (!stillOurs()) return;
    if (latest) {
      await convStore.loadConversation(latest.id, { unlessChanged: true });
    } else {
      convStore.clearCurrentConversation();
    }
  } catch {
    if (stillOurs()) convStore.clearCurrentConversation();
  }
}

/**
 * Counts the picks made on this device. A load that reads the server before a
 * pick is saved answers after it, with the selection from before; it must not
 * put that back (#364). A load started after the pick reads the saved one.
 */
let picks = 0;

export const usePersonaStore = create<PersonaState>((set, get) => ({
  personas: [],
  selectedPersonaId: null,
  selectionLoaded: false,
  isLoading: false,

  loadPersonas: async () => {
    try {
      set({ isLoading: true });
      const picksBefore = picks;
      const [personas, assistant] = await Promise.all([apiClient.listPersonas(), apiClient.getAssistant()]);
      // The server clears a selection whose persona is disabled or deleted; one
      // missing from the list anyway still falls back to the assistant, never to
      // another persona the user did not pick.
      const selected = picks === picksBefore ? assistant.selected_persona_id : get().selectedPersonaId;
      const finalId = selected !== null && personas.some((p) => p.id === selected) ? selected : null;
      set({ personas, selectedPersonaId: finalId, selectionLoaded: true });
    } catch (err) {
      console.error('Failed to load personas:', err);
    } finally {
      set({ isLoading: false, selectionLoaded: true });
    }
  },

  openLatestConversation,

  selectPersona: async (id: number | null) => {
    const previous = get().selectedPersonaId;
    picks += 1;
    set({ selectedPersonaId: id });
    try {
      // The account's, so every conversation and every device answers as it.
      await apiClient.updateAssistant({ selected_persona_id: id });
    } catch (err) {
      set({ selectedPersonaId: previous });
      throw err;
    }
  },
}));
