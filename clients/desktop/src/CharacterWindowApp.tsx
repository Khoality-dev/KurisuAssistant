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
  const amplitudeRef = useRef<AmplitudeState>({ amplitude: 0, isPlaying: false, isThinking: false });
  const silentRef = useRef<AmplitudeState>({ amplitude: 0, isPlaying: false, isThinking: false });
  const gesturesRef = useRef<string[]>([]);

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
                existing.poseTree?.default_pose_id !== agent.poseTree?.default_pose_id ||
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

    // Signal to main renderer that listeners are ready — triggers initial data push
    api.signalReady();

    return () => {
      cleanupAmplitude();
      cleanupAgents();
      cleanupGestures();
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
