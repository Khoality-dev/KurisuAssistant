import { useEffect, useRef, useCallback } from 'react';
import { apiClient } from '@kurisu/api';
import { parseCharacterConfig, type Message } from '@kurisu/models';
import { characterSurfaceWanted, publishSubtitle, useCharacterStore } from '@kurisu/state';

interface UseCharacterPanelParams {
  messages: Message[];
  currentConversationId: number | null;
}

/**
 * Which personas are in the conversation and which one is speaking, kept in
 * the character store for whatever surface is showing (#238).
 *
 * This is the producer of the persona half of the feed and nothing else:
 * speech, thinking, gestures and faces are written by their own producers,
 * and the IPC mirror to the second window is `useCharacterBridgeSync`. A
 * persona's config is fetched the first time it appears in the conversation,
 * again (bypassing the cache) when it starts speaking, and again when the
 * editor saves it.
 */
export function useCharacterPanel({ messages, currentConversationId }: UseCharacterPanelParams) {
  const wanted = useCharacterStore(characterSurfaceWanted);
  const personaCacheRef = useRef<Set<number>>(new Set()); // IDs already fetched

  // Subtitle: the sentence about to play and how long it lasts, for whichever surface shows subtitles.
  const onTTSPlaybackStart = useCallback((text: string, duration: number) => {
    publishSubtitle({ text, isUser: false, duration });
  }, []);

  // Fetch a persona and add/update the store's entry. forceRefresh=true
  // bypasses the cache (used when a persona starts speaking, to pick up config
  // changes saved since it was last fetched).
  const fetchPersonaForPanel = useCallback((personaId: number, personaName?: string, forceRefresh = false) => {
    if (!forceRefresh && personaCacheRef.current.has(personaId)) return;
    personaCacheRef.current.add(personaId);
    apiClient.getPersona(personaId).then((persona) => {
      const character = parseCharacterConfig(persona.character_config);
      // Migrate legacy video_url to video_urls on edges
      if (character?.poseTree?.edges) {
        for (const e of character.poseTree.edges) {
          const raw = e as any;
          if (raw.video_url && !raw.video_urls?.length) {
            raw.video_urls = [raw.video_url];
            delete raw.video_url;
          }
        }
      }
      useCharacterStore.getState().setPersona(personaId, {
        name: persona.name,
        avatarUuid: persona.avatar_uuid ?? null,
        character,
      });
    }).catch(() => {
      // Still add to the store with no character, so a surface shows the name
      useCharacterStore.getState().setPersona(personaId, {
        name: personaName || `Persona ${personaId}`,
        avatarUuid: null,
        character: null,
      });
    });
  }, []);

  // Set the speaking persona during streaming (for lip sync)
  const pushPersonaCharacterConfig = useCallback((personaId: number | undefined, personaName?: string) => {
    if (!personaId) return;
    useCharacterStore.getState().setActivePersonaId(personaId);
    fetchPersonaForPanel(personaId, personaName, true);
  }, [fetchPersonaForPanel]);

  const setActivePersonaId = useCallback((id: number | null) => {
    useCharacterStore.getState().setActivePersonaId(id);
  }, []);

  // Reset the personas when the conversation changes
  useEffect(() => {
    useCharacterStore.getState().clearPersonas();
    personaCacheRef.current.clear();
    useCharacterStore.getState().setActivePersonaId(null);
  }, [currentConversationId]);

  // Scan messages for personas while a surface is showing. Tool messages carry
  // no persona (the wire sets persona_id/persona_name to null on them), so
  // they are skipped by the persona_id guard.
  useEffect(() => {
    if (!wanted) return;
    for (const msg of messages) {
      const name = msg.persona?.name || msg.name;
      if (msg.persona_id && !personaCacheRef.current.has(msg.persona_id)) {
        fetchPersonaForPanel(msg.persona_id, name);
      }
    }
  }, [messages, wanted, fetchPersonaForPanel]);

  // Re-fetch character configs when saved in the editor dialog
  useEffect(() => {
    const handler = (e: Event) => {
      const personaId = (e as CustomEvent).detail?.personaId as number | undefined;
      if (personaId && useCharacterStore.getState().personas.has(personaId)) {
        fetchPersonaForPanel(personaId, undefined, true);
      }
    };
    window.addEventListener('character-config-saved', handler);
    return () => window.removeEventListener('character-config-saved', handler);
  }, [fetchPersonaForPanel]);

  return {
    setActivePersonaId,
    pushPersonaCharacterConfig,
    onTTSPlaybackStart,
  };
}
