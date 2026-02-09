import React, { useRef, useEffect } from 'react';
import { CanvasCompositor } from './engine/CanvasCompositor';
import type { PoseConfig } from './types';
import { config } from '../config';

export interface AmplitudeState {
  amplitude: number;
  isPlaying: boolean;
}

interface CharacterRendererProps {
  poseConfig: PoseConfig | null;
  amplitudeRef: React.RefObject<AmplitudeState>;
  width?: number;
  height?: number;
}

export const CharacterRenderer: React.FC<CharacterRendererProps> = ({
  poseConfig,
  amplitudeRef,
  width = 400,
  height = 600,
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

  // Load pose config when it changes
  useEffect(() => {
    if (!compositorRef.current) return;
    if (poseConfig) {
      compositorRef.current.loadPose(poseConfig, config.apiBaseUrl).catch((err) => {
        console.error('Failed to load pose:', err);
      });
    } else {
      compositorRef.current.clearPose();
    }
  }, [poseConfig]);

  // Sync amplitude from ref to compositor at ~60fps (no React re-renders)
  useEffect(() => {
    let rafId: number;
    const sync = () => {
      if (compositorRef.current && amplitudeRef.current) {
        compositorRef.current.mouthAmplitude = amplitudeRef.current.amplitude;
        compositorRef.current.isAudioPlaying = amplitudeRef.current.isPlaying;
      }
      rafId = requestAnimationFrame(sync);
    };
    rafId = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(rafId);
  }, [amplitudeRef]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{
        display: 'block',
        maxWidth: '100%',
        maxHeight: '100%',
        objectFit: 'contain',
      }}
    />
  );
};
