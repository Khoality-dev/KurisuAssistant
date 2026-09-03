import React, { useState, useRef, useEffect } from 'react';
import {
  Box,
  Typography,
  CircularProgress,
} from '@mui/material';
import type { PoseConfig } from '../../videocall/types';
import { CanvasCompositor } from '../../videocall/engine/CanvasCompositor';
import { config } from '../../config';

interface PreviewCanvasProps {
  poseConfig: PoseConfig;
  testMouth: boolean;
  testLeftEye: boolean;
  testRightEye: boolean;
  breathing: boolean;
}

const PREVIEW_W = 400;
const PREVIEW_H = 540;

const PreviewCanvas: React.FC<PreviewCanvasProps> = ({ poseConfig, testMouth, testLeftEye, testRightEye, breathing }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compositorRef = useRef<CanvasCompositor | null>(null);
  const mouthAnimRef = useRef<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = PREVIEW_W * dpr;
    canvas.height = PREVIEW_H * dpr;

    if (compositorRef.current) {
      compositorRef.current.destroy();
    }

    const compositor = new CanvasCompositor(canvas);
    compositorRef.current = compositor;
    setLoading(true);
    setLoadError('');

    let cancelled = false;

    compositor
      .loadPose(poseConfig, config.apiBaseUrl)
      .then(() => {
        if (!cancelled) {
          compositor.start();
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Preview load failed:', err);
          setLoadError(err.message || 'Failed to load preview');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      compositor.destroy();
      compositorRef.current = null;
    };
  }, [poseConfig]);

  useEffect(() => {
    const compositor = compositorRef.current;
    if (!compositor) return;

    if (!testMouth) {
      compositor.mouthAmplitude = 0;
      compositor.isAudioPlaying = false;
      if (mouthAnimRef.current) {
        cancelAnimationFrame(mouthAnimRef.current);
        mouthAnimRef.current = null;
      }
      return;
    }

    compositor.isAudioPlaying = true;
    const startTime = performance.now();
    const animate = () => {
      if (compositorRef.current) {
        const t = (performance.now() - startTime) / 1000;
        compositorRef.current.mouthAmplitude = (Math.sin(t * 4) + 1) / 2;
      }
      mouthAnimRef.current = requestAnimationFrame(animate);
    };
    mouthAnimRef.current = requestAnimationFrame(animate);

    return () => {
      if (mouthAnimRef.current) {
        cancelAnimationFrame(mouthAnimRef.current);
        mouthAnimRef.current = null;
      }
    };
  }, [testMouth]);

  useEffect(() => {
    const compositor = compositorRef.current;
    if (!compositor) return;

    if (testLeftEye) {
      const numPatches = poseConfig.left_eye.patches.length;
      if (numPatches > 0) {
        compositor.leftEyeOverride = 1;
        let idx = 1;
        const interval = setInterval(() => {
          idx = idx >= numPatches ? 0 : idx + 1;
          if (compositorRef.current) compositorRef.current.leftEyeOverride = idx;
        }, 500);
        return () => {
          clearInterval(interval);
          if (compositorRef.current) compositorRef.current.leftEyeOverride = -1;
        };
      }
    } else {
      compositor.leftEyeOverride = -1;
    }
  }, [testLeftEye, poseConfig]);

  useEffect(() => {
    const compositor = compositorRef.current;
    if (!compositor) return;

    if (testRightEye) {
      const numPatches = poseConfig.right_eye.patches.length;
      if (numPatches > 0) {
        compositor.rightEyeOverride = 1;
        let idx = 1;
        const interval = setInterval(() => {
          idx = idx >= numPatches ? 0 : idx + 1;
          if (compositorRef.current) compositorRef.current.rightEyeOverride = idx;
        }, 500);
        return () => {
          clearInterval(interval);
          if (compositorRef.current) compositorRef.current.rightEyeOverride = -1;
        };
      }
    } else {
      compositor.rightEyeOverride = -1;
    }
  }, [testRightEye, poseConfig]);

  useEffect(() => {
    const compositor = compositorRef.current;
    if (!compositor) return;
    compositor.breathingEnabled = breathing;
  }, [breathing]);

  return (
    <Box
      sx={{
        width: PREVIEW_W,
        height: PREVIEW_H,
        flexShrink: 0,
        border: '2px solid',
        borderColor: 'primary.main',
        borderRadius: 2,
        overflow: 'hidden',
        bgcolor: 'grey.100',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: PREVIEW_W, height: PREVIEW_H }}
      />
      {loading && (
        <CircularProgress
          size={40}
          sx={{ position: 'absolute', color: 'primary.main' }}
        />
      )}
      {loadError && (
        <Typography
          variant="caption"
          color="error"
          sx={{ position: 'absolute', textAlign: 'center', px: 2 }}
        >
          {loadError}
        </Typography>
      )}
    </Box>
  );
};

export { PreviewCanvas, PREVIEW_W, PREVIEW_H };
export type { PreviewCanvasProps };
