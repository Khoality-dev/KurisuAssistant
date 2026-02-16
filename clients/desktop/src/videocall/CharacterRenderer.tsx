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
  gesturesRef?: React.RefObject<string[]>;
  facesRef?: React.RefObject<string[]>;
}

export const CharacterRenderer: React.FC<CharacterRendererProps> = ({
  poseTree,
  amplitudeRef,
  gesturesRef,
  facesRef,
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

  // Sync amplitude + gestures from refs to compositor at ~60fps (no React re-renders)
  useEffect(() => {
    let rafId: number;
    const sync = () => {
      if (compositorRef.current && amplitudeRef.current) {
        compositorRef.current.mouthAmplitude = amplitudeRef.current.amplitude;
        compositorRef.current.isAudioPlaying = amplitudeRef.current.isPlaying;
        compositorRef.current.isThinking = amplitudeRef.current.isThinking;
      }
      // Forward gestures (consumed once by compositor)
      if (compositorRef.current && gesturesRef?.current && gesturesRef.current.length > 0) {
        compositorRef.current.setGestures(gesturesRef.current);
        gesturesRef.current = [];
      }
      // Forward faces (continuous state, not consumed)
      if (compositorRef.current && facesRef?.current) {
        compositorRef.current.setFaces(facesRef.current);
      }
      rafId = requestAnimationFrame(sync);
    };
    rafId = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(rafId);
  }, [amplitudeRef, gesturesRef, facesRef]);

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
