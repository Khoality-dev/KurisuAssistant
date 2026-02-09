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
}

export const CharacterRenderer: React.FC<CharacterRendererProps> = ({
  poseConfig,
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

  // Load pose config when it changes
  useEffect(() => {
    if (!compositorRef.current) return;
    if (poseConfig) {
      console.log('[CharacterRenderer] loadPose called with:', {
        name: poseConfig.name,
        base_image_url: poseConfig.base_image_url,
        left_eye_patches: poseConfig.left_eye?.patches?.length ?? 'MISSING',
        right_eye_patches: poseConfig.right_eye?.patches?.length ?? 'MISSING',
        mouth_patches: poseConfig.mouth?.patches?.length ?? 'MISSING',
      });
      compositorRef.current.loadPose(poseConfig, config.apiBaseUrl).then(() => {
        const pose = compositorRef.current?.getPose();
        if (pose) {
          console.log('[CharacterRenderer] Pose loaded OK:', {
            leftEyePatches: pose.leftEyePatches.length,
            rightEyePatches: pose.rightEyePatches.length,
            mouthPatches: pose.mouthPatches.length,
            baseImageSize: `${pose.baseImage.naturalWidth}x${pose.baseImage.naturalHeight}`,
          });
        }
      }).catch((err) => {
        console.error('[CharacterRenderer] Failed to load pose:', err);
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
