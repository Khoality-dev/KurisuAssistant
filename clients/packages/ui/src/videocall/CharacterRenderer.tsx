import React, { useRef, useEffect } from 'react';
import { CanvasCompositor } from './engine/CanvasCompositor';
import type { AmplitudeState, PoseTree } from '@kurisu/models';
import { config } from '@kurisu/api';

interface CharacterRendererProps {
  poseTree: PoseTree | null;
  amplitudeRef: React.RefObject<AmplitudeState>;
  gesturesRef?: React.MutableRefObject<string[]>;
  facesRef?: React.RefObject<string[]>;
  /**
   * Bumped by the host each time a session with a token arrives. A load that
   * failed — a 401 the session round trip did not answer in time, a network
   * blip — is retried on the next bump; a load that succeeded ignores it, so
   * a routine token refresh never reloads the art (#237).
   */
  sessionVersion?: number;
}

export const CharacterRenderer: React.FC<CharacterRendererProps> = ({
  poseTree,
  amplitudeRef,
  gesturesRef,
  facesRef,
  sessionVersion = 0,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compositorRef = useRef<CanvasCompositor | null>(null);
  const loadFailedRef = useRef(false);
  const loadedTreeRef = useRef<PoseTree | null | undefined>(undefined);

  // Initialize compositor
  useEffect(() => {
    if (!canvasRef.current) return;
    const compositor = new CanvasCompositor(canvasRef.current);
    compositor.start();
    compositorRef.current = compositor;
    return () => {
      compositor.destroy();
      // A new compositor (StrictMode re-runs this in dev) has nothing loaded.
      loadedTreeRef.current = undefined;
      loadFailedRef.current = false;
    };
  }, []);

  // Load pose tree when it changes, and again after a failure once a session
  // arrives. `sessionVersion` is in the deps so the effect runs on a bump; the
  // guard below makes a bump a no-op unless the last load failed.
  useEffect(() => {
    if (!compositorRef.current) return;
    const treeChanged = poseTree !== loadedTreeRef.current;
    loadedTreeRef.current = poseTree;
    if (!treeChanged && !loadFailedRef.current) return; // a session with nothing to retry
    if (poseTree) {
      loadFailedRef.current = false;
      compositorRef.current.loadPoseTree(poseTree, config.apiBaseUrl).catch((err) => {
        loadFailedRef.current = true;
        console.error('[CharacterRenderer] Failed to load pose tree:', err);
      });
    } else {
      loadFailedRef.current = false;
      compositorRef.current.clearPose();
    }
  }, [poseTree, sessionVersion]);

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
