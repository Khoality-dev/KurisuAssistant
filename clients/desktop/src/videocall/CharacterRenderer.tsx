import React, { useRef, useEffect } from 'react';
import { CanvasCompositor } from './engine/CanvasCompositor';
import type { PoseTree } from './types';
import { config } from '../config';

export interface AmplitudeState {
  amplitude: number;
  isPlaying: boolean;
  isThinking: boolean;
}

interface CharacterRendererProps {
  poseTree: PoseTree | null;
  amplitudeRef: React.RefObject<AmplitudeState>;
}

export const CharacterRenderer: React.FC<CharacterRendererProps> = ({
  poseTree,
  amplitudeRef,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compositorRef = useRef<CanvasCompositor | null>(null);

  // Initialize compositor
  useEffect(() => {
    if (!canvasRef.current) return;
    const compositor = new CanvasCompositor(canvasRef.current);
    compositor.start();
    compositorRef.current = compositor;
    return () => compositor.destroy();
  }, []);

  // Load pose tree when it changes
  useEffect(() => {
    if (!compositorRef.current) return;
    if (poseTree) {
      compositorRef.current.loadPoseTree(poseTree, config.apiBaseUrl).catch((err) => {
        console.error('[CharacterRenderer] Failed to load pose tree:', err);
      });
    } else {
      compositorRef.current.clearPose();
    }
  }, [poseTree]);

  // Sync amplitude from ref to compositor at ~60fps (no React re-renders)
  useEffect(() => {
    let rafId: number;
    const sync = () => {
      if (compositorRef.current && amplitudeRef.current) {
        compositorRef.current.mouthAmplitude = amplitudeRef.current.amplitude;
        compositorRef.current.isAudioPlaying = amplitudeRef.current.isPlaying;
        compositorRef.current.isThinking = amplitudeRef.current.isThinking;
      }
      rafId = requestAnimationFrame(sync);
    };
    rafId = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(rafId);
  }, [amplitudeRef]);

  return (
    <canvas
      ref={canvasRef}
      width={400}
      height={600}
      style={{
        display: 'block',
        maxWidth: '100%',
        maxHeight: '100%',
        objectFit: 'contain',
      }}
    />
  );
};
