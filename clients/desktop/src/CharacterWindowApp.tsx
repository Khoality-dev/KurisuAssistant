import React, { useState, useEffect, useRef } from 'react';
import { CharacterRenderer } from './videocall/CharacterRenderer';
import type { AmplitudeState } from './videocall/CharacterRenderer';
import type { PoseTree } from './videocall/types';

interface AgentEntry {
  name: string;
  poseTree: PoseTree | null;
}

export const CharacterWindowApp: React.FC = () => {
  const [agentMap, setAgentMap] = useState<Map<number, AgentEntry>>(new Map());
  const [activeAgentId, setActiveAgentId] = useState<number | null>(null);
  const [subtitleText, setSubtitleText] = useState('');
  const [subtitleVisible, setSubtitleVisible] = useState(false);
  const [subtitleIsUser, setSubtitleIsUser] = useState(false);
  const subtitleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subtitleQueueRef = useRef<Array<{ text: string; durationMs: number }>>([]);
  const subtitleDrainingRef = useRef(false);
  const amplitudeRef = useRef<AmplitudeState>({ amplitude: 0, isPlaying: false, isThinking: false });
  const silentRef = useRef<AmplitudeState>({ amplitude: 0, isPlaying: false, isThinking: false });
  const gesturesRef = useRef<string[]>([]);
  const facesRef = useRef<string[]>([]);

  useEffect(() => {
    const api = window.electron?.characterWindow;
    if (!api) return;

    const cleanupAmplitude = api.onAmplitude((data) => {
      amplitudeRef.current = data;
    });

    const cleanupAgents = api.onAgentsUpdate((data) => {
      setActiveAgentId(data.activeAgentId);
      // Only rebuild agentMap if agents actually changed (avoids re-triggering loadPoseTree)
      setAgentMap((prev) => {
        if (prev.size === data.agents.length) {
          let same = true;
          for (const agent of data.agents) {
            const existing = prev.get(agent.id);
            if (!existing || existing.name !== agent.name ||
                JSON.stringify(existing.poseTree?.default_pose_ids) !== JSON.stringify(agent.poseTree?.default_pose_ids) ||
                existing.poseTree?.nodes?.length !== agent.poseTree?.nodes?.length ||
                existing.poseTree?.edges?.length !== agent.poseTree?.edges?.length) {
              same = false;
              break;
            }
          }
          if (same) return prev;
        }
        const map = new Map<number, AgentEntry>();
        for (const agent of data.agents) {
          map.set(agent.id, { name: agent.name, poseTree: agent.poseTree });
        }
        return map;
      });
    });

    const cleanupGestures = api.onGestureUpdate((data) => {
      gesturesRef.current = data.gestures;
    });

    const cleanupFaces = api.onFaceUpdate((data) => {
      facesRef.current = data.faces;
    });

    // Helper: clear subtitle timer
    const clearSubtitleTimer = () => {
      if (subtitleTimerRef.current) { clearTimeout(subtitleTimerRef.current); subtitleTimerRef.current = null; }
    };

    // Split text into sentences on .!?。！？\n boundaries
    const splitSentences = (text: string): string[] =>
      text.split(/(?<=[.!?。！？\n])\s*/).map(s => s.trim()).filter(Boolean);

    // Queue drain: show one sentence at a time for its duration, fade only after last
    const drainQueue = () => {
      if (subtitleQueueRef.current.length === 0) {
        subtitleDrainingRef.current = false;
        subtitleTimerRef.current = setTimeout(() => setSubtitleVisible(false), 1000);
        return;
      }
      subtitleDrainingRef.current = true;
      const item = subtitleQueueRef.current.shift()!;
      setSubtitleText(item.text);
      setSubtitleIsUser(false);
      setSubtitleVisible(true);
      subtitleTimerRef.current = setTimeout(drainQueue, item.durationMs);
    };

    const cleanupSubtitle = api.onSubtitle((data) => {
      if (!data.text) {
        // Cancel: clear everything and hide
        clearSubtitleTimer();
        subtitleQueueRef.current = [];
        subtitleDrainingRef.current = false;
        setSubtitleVisible(false);
        return;
      }

      if (data.isUser) {
        // User text: show immediately, interrupt queue
        clearSubtitleTimer();
        subtitleQueueRef.current = [];
        subtitleDrainingRef.current = false;
        setSubtitleText(data.text);
        setSubtitleIsUser(true);
        setSubtitleVisible(true);
        const words = data.text.split(/\s+/).filter(Boolean);
        const displayMs = Math.max(1500, words.length * 350);
        subtitleTimerRef.current = setTimeout(() => setSubtitleVisible(false), displayMs);
      } else {
        // Agent text: split into sentences, push to queue, let drain handle timing
        const chunkDurationMs = (data.duration || 4) * 1000;
        const sentences = splitSentences(data.text);
        if (!sentences.length) return;
        const perSentenceMs = chunkDurationMs / sentences.length;
        for (const sentence of sentences) {
          subtitleQueueRef.current.push({ text: sentence, durationMs: perSentenceMs });
        }
        if (!subtitleDrainingRef.current) {
          drainQueue();
        }
      }
    });

    // Signal to main renderer that listeners are ready — triggers initial data push
    api.signalReady();

    return () => {
      cleanupAmplitude();
      cleanupAgents();
      cleanupGestures();
      cleanupFaces();
      cleanupSubtitle();
      if (subtitleTimerRef.current) clearTimeout(subtitleTimerRef.current);
      subtitleQueueRef.current = [];
    };
  }, []);

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: '#ffffff',
        // @ts-expect-error Electron CSS property for frameless window dragging
        WebkitAppRegion: 'drag',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Subtitle overlay */}
      <div
        style={{
          position: 'absolute',
          bottom: 28,
          left: 0,
          right: 0,
          zIndex: 10,
          display: 'flex',
          justifyContent: 'center',
          pointerEvents: 'none',
          // @ts-expect-error Electron CSS property
          WebkitAppRegion: 'no-drag',
        }}
      >
        <div
          style={{
            maxWidth: '90%',
            padding: subtitleText ? '6px 16px' : 0,
            backgroundColor: 'rgba(0, 0, 0, 0.65)',
            borderRadius: 8,
            color: '#fff',
            fontSize: 15,
            lineHeight: 1.4,
            textAlign: 'center',
            fontStyle: subtitleIsUser ? 'italic' : 'normal',
            opacity: subtitleVisible ? (subtitleIsUser ? 0.7 : 1) : 0,
            transition: 'opacity 0.4s ease',
            wordBreak: 'break-word',
          }}
        >
          {subtitleText}
        </div>
      </div>

      {agentMap.size === 0 ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <span style={{ color: 'rgba(0,0,0,0.4)', fontSize: 14 }}>
            Send a message to see agents here
          </span>
        </div>
      ) : (
        Array.from(agentMap.entries()).map(([id, entry]) => (
          <div
            key={id}
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
              overflow: 'hidden',
              borderBottom: '1px solid rgba(0,0,0,0.1)',
              ...(activeAgentId === id
                ? { boxShadow: 'inset 0 0 20px rgba(37, 99, 235, 0.3)' }
                : {}),
            }}
          >
            {entry.poseTree ? (
              <CharacterRenderer
                poseTree={entry.poseTree}
                amplitudeRef={activeAgentId === id ? amplitudeRef : silentRef}
                gesturesRef={activeAgentId === id || activeAgentId === null ? gesturesRef : undefined}
                facesRef={activeAgentId === id || activeAgentId === null ? facesRef : undefined}
              />
            ) : (
              <span style={{ color: 'rgba(0,0,0,0.3)', fontSize: 14 }}>
                No avatar
              </span>
            )}
            <span
              style={{
                position: 'absolute',
                bottom: 4,
                left: 0,
                right: 0,
                textAlign: 'center',
                color: activeAgentId === id ? '#2563eb' : 'rgba(0,0,0,0.5)',
                fontWeight: activeAgentId === id ? 600 : 400,
                fontSize: 18,
                textShadow: '0 1px 4px rgba(255,255,255,0.5)',
              }}
            >
              {entry.name}
            </span>
          </div>
        ))
      )}
    </div>
  );
};
