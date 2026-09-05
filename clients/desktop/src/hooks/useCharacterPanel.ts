import { useState, useEffect, useRef, useCallback } from 'react';
import { apiClient } from '../api/client';
import type { AmplitudeState } from '../videocall/CharacterRenderer';
import type { PoseTree } from '../videocall/types';
import type { Message } from '../api/types';

interface PersonaEntry { name: string; poseTree: PoseTree | null }

interface UseCharacterPanelParams {
  characterWindowOpen: boolean;
  messages: Message[];
  currentConversationId: number | null;
}

export function useCharacterPanel({
  characterWindowOpen,
  messages,
  currentConversationId,
}: UseCharacterPanelParams) {
  // Amplitude state (updated via ref to avoid re-renders, sent to character window via IPC)
  const amplitudeRef = useRef<AmplitudeState>({ amplitude: 0, isPlaying: false, isThinking: false });
  const onAmplitudeUpdate = useCallback((amplitude: number, isPlaying: boolean) => {
    amplitudeRef.current = { ...amplitudeRef.current, amplitude, isPlaying };
  }, []);

  // Character panel state for every persona seen in the conversation
  const [personaMap, setPersonaMap] = useState<Map<number, PersonaEntry>>(new Map());
  const [activePersonaId, setActivePersonaId] = useState<number | null>(null);
  const personaCacheRef = useRef<Set<number>>(new Set()); // IDs already fetched

  // Subtitle: send TTS segment text + duration to character window for word-by-word reveal
  const onTTSPlaybackStart = useCallback((text: string, duration: number) => {
    window.electron?.characterWindow?.sendSubtitle({ text, isUser: false, duration });
  }, []);

  // Fetch a persona and add/update the character panel map.
  // forceRefresh=true bypasses the cache (used when a persona starts speaking, to
  // pick up config changes saved since it was last fetched).
  const fetchPersonaForPanel = useCallback((personaId: number, personaName?: string, forceRefresh = false) => {
    if (!forceRefresh && personaCacheRef.current.has(personaId)) return;
    personaCacheRef.current.add(personaId);
    apiClient.getPersona(personaId).then((persona) => {
      const cc = persona.character_config;
      const poseTree = cc?.pose_tree ?? null;
      // Migrate legacy video_url to video_urls on edges
      if (poseTree?.edges) {
        for (const e of poseTree.edges) {
          const raw = e as any;
          if (raw.video_url && !raw.video_urls?.length) {
            e.video_urls = [raw.video_url];
            delete raw.video_url;
          }
        }
      }
      setPersonaMap((prev) => {
        const next = new Map(prev);
        next.set(personaId, { name: persona.name, poseTree });
        return next;
      });
    }).catch(() => {
      // Still add to map with null config so we show the name
      setPersonaMap((prev) => {
        const next = new Map(prev);
        next.set(personaId, { name: personaName || `Persona ${personaId}`, poseTree: null });
        return next;
      });
    });
  }, []);

  // Set the speaking persona during streaming (for lip sync)
  const pushPersonaCharacterConfig = useCallback((personaId: number | undefined, personaName?: string) => {
    if (!personaId) return;
    setActivePersonaId(personaId);
    fetchPersonaForPanel(personaId, personaName, true);
  }, [fetchPersonaForPanel]);

  // Reset the persona map when the conversation changes
  useEffect(() => {
    setPersonaMap(new Map());
    personaCacheRef.current.clear();
    setActivePersonaId(null);
  }, [currentConversationId]);

  // Scan messages for personas to populate the character panel. Tool messages
  // carry no persona (the wire sets persona_id/persona_name to null on them), so
  // they are skipped by the persona_id guard.
  useEffect(() => {
    if (!characterWindowOpen) return;
    for (const msg of messages) {
      const name = msg.persona?.name || msg.name;
      if (msg.persona_id && !personaCacheRef.current.has(msg.persona_id)) {
        fetchPersonaForPanel(msg.persona_id, name);
      }
    }
  }, [messages, characterWindowOpen, fetchPersonaForPanel]);

  // IPC bridge: send amplitude to character window at ~30fps
  useEffect(() => {
    if (!characterWindowOpen) return;
    const api = window.electron?.characterWindow;
    if (!api) return;
    const interval = setInterval(() => {
      api.sendAmplitude(amplitudeRef.current);
    }, 33);
    return () => clearInterval(interval);
  }, [characterWindowOpen]);

  // IPC bridge: send persona map + active persona to character window
  const personaStateRef = useRef({ personaMap, activePersonaId });
  personaStateRef.current = { personaMap, activePersonaId };

  const sendPersonaState = useCallback(() => {
    const api = window.electron?.characterWindow;
    if (!api) return;
    const { personaMap: map, activePersonaId: id } = personaStateRef.current;
    const personas = Array.from(map.entries()).map(([personaId, entry]) => ({
      id: personaId,
      name: entry.name,
      poseTree: entry.poseTree,
    }));
    api.sendPersonasUpdate({ personas, activePersonaId: id });
  }, []);

  useEffect(() => {
    if (!characterWindowOpen) return;
    sendPersonaState();
  }, [characterWindowOpen, personaMap, activePersonaId, sendPersonaState]);

  // Re-send state when character window signals it's ready (after loading)
  useEffect(() => {
    if (!characterWindowOpen) return;
    const api = window.electron?.characterWindow;
    if (!api) return;
    const cleanup = api.onCharacterReady(() => {
      sendPersonaState();
    });
    return cleanup;
  }, [characterWindowOpen, sendPersonaState]);

  // Re-fetch character configs when saved in the editor dialog
  useEffect(() => {
    const handler = (e: Event) => {
      const personaId = (e as CustomEvent).detail?.personaId as number | undefined;
      if (personaId && personaMap.has(personaId)) {
        fetchPersonaForPanel(personaId, undefined, true);
      }
    };
    window.addEventListener('character-config-saved', handler);
    return () => window.removeEventListener('character-config-saved', handler);
  }, [personaMap, fetchPersonaForPanel]);

  return {
    amplitudeRef,
    activePersonaId,
    setActivePersonaId,
    pushPersonaCharacterConfig,
    onAmplitudeUpdate,
    onTTSPlaybackStart,
  };
}
