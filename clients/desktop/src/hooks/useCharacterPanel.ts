import { useState, useEffect, useRef, useCallback } from 'react';
import { apiClient } from '../api/client';
import type { AmplitudeState } from '../videocall/CharacterRenderer';
import type { PoseTree } from '../videocall/types';
import type { Message } from '../api/types';

interface AgentEntry { name: string; poseTree: PoseTree | null }

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

  // Character panel state for all agents in the conversation
  const [agentMap, setAgentMap] = useState<Map<number, AgentEntry>>(new Map());
  const [activeAgentId, setActiveAgentId] = useState<number | null>(null);
  const agentCacheRef = useRef<Set<number>>(new Set()); // IDs already fetched

  // Subtitle: send TTS segment text + duration to character window for word-by-word reveal
  const onTTSPlaybackStart = useCallback((text: string, duration: number) => {
    window.electron?.characterWindow?.sendSubtitle({ text, isUser: false, duration });
  }, []);

  // Fetch agent and add/update the character panel map
  // forceRefresh=true bypasses cache (used when agent becomes active, to pick up config changes)
  const fetchAgentForPanel = useCallback((agentId: number, agentName?: string, forceRefresh = false) => {
    if (!forceRefresh && agentCacheRef.current.has(agentId)) return;
    agentCacheRef.current.add(agentId);
    apiClient.getAgent(agentId).then((agent) => {
      const cc = agent.character_config;
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
      setAgentMap((prev) => {
        const next = new Map(prev);
        next.set(agentId, { name: agent.name, poseTree });
        return next;
      });
    }).catch(() => {
      // Still add to map with null config so we show the name
      setAgentMap((prev) => {
        const next = new Map(prev);
        next.set(agentId, { name: agentName || `Agent ${agentId}`, poseTree: null });
        return next;
      });
    });
  }, []);

  // Set active agent during streaming (for lip sync)
  const pushAgentCharacterConfig = useCallback((agentId: number | undefined, agentName?: string) => {
    if (!agentId) return;
    setActiveAgentId(agentId);
    fetchAgentForPanel(agentId, agentName, true);
  }, [fetchAgentForPanel]);

  // Reset agent map when conversation changes
  useEffect(() => {
    setAgentMap(new Map());
    agentCacheRef.current.clear();
    setActiveAgentId(null);
  }, [currentConversationId]);

  // Scan messages for agents to populate the character panel
  useEffect(() => {
    if (!characterWindowOpen) return;
    for (const msg of messages) {
      const name = msg.agent?.name || msg.name;
      if (msg.agent_id && !agentCacheRef.current.has(msg.agent_id)) {
        fetchAgentForPanel(msg.agent_id, name);
      }
    }
  }, [messages, characterWindowOpen, fetchAgentForPanel]);

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

  // IPC bridge: send agent map + active agent to character window
  const agentStateRef = useRef({ agentMap, activeAgentId });
  agentStateRef.current = { agentMap, activeAgentId };

  const sendAgentState = useCallback(() => {
    const api = window.electron?.characterWindow;
    if (!api) return;
    const { agentMap: map, activeAgentId: id } = agentStateRef.current;
    const agents = Array.from(map.entries()).map(([agentId, entry]) => ({
      id: agentId,
      name: entry.name,
      poseTree: entry.poseTree,
    }));
    api.sendAgentsUpdate({ agents, activeAgentId: id });
  }, []);

  useEffect(() => {
    if (!characterWindowOpen) return;
    sendAgentState();
  }, [characterWindowOpen, agentMap, activeAgentId, sendAgentState]);

  // Re-send state when character window signals it's ready (after loading)
  useEffect(() => {
    if (!characterWindowOpen) return;
    const api = window.electron?.characterWindow;
    if (!api) return;
    const cleanup = api.onCharacterReady(() => {
      sendAgentState();
    });
    return cleanup;
  }, [characterWindowOpen, sendAgentState]);

  // Re-fetch character configs when saved in the editor dialog
  useEffect(() => {
    const handler = (e: Event) => {
      const agentId = (e as CustomEvent).detail?.agentId as number | undefined;
      if (agentId && agentMap.has(agentId)) {
        fetchAgentForPanel(agentId, undefined, true);
      }
    };
    window.addEventListener('character-config-saved', handler);
    return () => window.removeEventListener('character-config-saved', handler);
  }, [agentMap, fetchAgentForPanel]);

  return {
    amplitudeRef,
    activeAgentId,
    setActiveAgentId,
    pushAgentCharacterConfig,
    onAmplitudeUpdate,
    onTTSPlaybackStart,
  };
}
