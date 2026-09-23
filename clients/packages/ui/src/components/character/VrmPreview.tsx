/**
 * The setup editor's live preview (#242): the persona's model, driven by the
 * editor's own buttons instead of a conversation.
 *
 * It is not the character surface. The surface reads the live feed — the
 * sentence being spoken, the camera's gestures — and the editor must not: a
 * Try button here has to wave now, not when somebody waves at the webcam. So
 * this drives `createVrmDriver` directly with a synthetic input, reloads only
 * when the model or the clip list changes, and hands every other setting to
 * `configure`, so a preset click shows at once without re-parsing a 40 MB file.
 *
 * three.js arrives through a dynamic import after `supportsWebGL` says the
 * display can draw, as on every other surface.
 */
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Box, CircularProgress, Typography } from '@mui/material';
import type { ParsedCharacterConfig, VrmEmotion, VrmReactionPlay, VrmSettings } from '@kurisu/models';
import { fetchAuthedBytes } from '@kurisu/api';
import { supportsWebGL } from '@kurisu/vrm/probe';
import type { VrmDriver } from '@kurisu/vrm';

export interface VrmPreviewHandle {
  /** Play what a reaction plays, now. */
  trigger(play: VrmReactionPlay): void;
  /** A gesture burst, as if the camera saw it: the reactions decide what happens. */
  gesture(name: string): void;
  /** Hold a face until another is asked for. */
  showEmotion(emotion: VrmEmotion): void;
}

export interface VrmPreviewProps {
  settings: VrmSettings;
  speaking: boolean;
  thinking: boolean;
  /** The load failed, or the display cannot draw 3D. */
  onError?: (message: string | null) => void;
}

/** Long enough to read as "held" in the preview; the next button replaces it. */
const HOLD_MS = 10 * 60 * 1000;

/** What forces a reload: the model and the clip files. Everything else is `configure`. */
function assetKey(settings: VrmSettings): string {
  const clips = (settings.clips ?? []).map((c) => `${c.id}:${c.sha256}`).join(',');
  return `${settings.model?.url ?? ''}@${settings.model?.sha256 ?? ''}|${clips}`;
}

/** A talking mouth without audio: two sines and a gap now and then, like the mockup. */
function syntheticAmplitude(tMs: number): number {
  const t = tMs / 1000;
  const gate = Math.sin(t * 3.1) + Math.sin(t * 4.7) > -0.6 ? 1 : 0.15;
  return Math.max(0, Math.min(1, (Math.sin(t * 11) * 0.5 + Math.sin(t * 17.3) * 0.35 + 0.3) * gate));
}

export const VrmPreview = forwardRef<VrmPreviewHandle, VrmPreviewProps>(({ settings, speaking, thinking, onError }, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const driverRef = useRef<VrmDriver | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'nogl' | 'failed'>('loading');
  const [failure, setFailure] = useState<string | null>(null);
  const inputRef = useRef({ speaking, thinking });
  inputRef.current = { speaking, thinking };
  const gesturesRef = useRef<string[]>([]);
  const cueRef = useRef<{ emotion: VrmEmotion; weight: number; hold_ms: number } | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useImperativeHandle(ref, () => ({
    trigger: (play) => driverRef.current?.trigger(play),
    gesture: (name) => { gesturesRef.current = [...gesturesRef.current, name]; },
    showEmotion: (emotion) => { cueRef.current = { emotion, weight: 1, hold_ms: HOLD_MS }; },
  }), []);

  const key = assetKey(settings);

  // Load (and reload) when the files change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !settings.model) return;
    if (!supportsWebGL(canvas)) {
      setState('nogl');
      onErrorRef.current?.('A 3D character needs hardware graphics on this display.');
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setState('loading');
    setFailure(null);
    (async () => {
      try {
        const vrm = await import('@kurisu/vrm');
        if (cancelled) return;
        // The canvas leaves with the driver: give its context back now, not at GC.
        const driver = driverRef.current ?? vrm.createVrmDriver(canvas, { releaseContextOnDispose: true });
        driverRef.current = driver;
        const box = boxRef.current;
        if (box) driver.resize(box.clientWidth, box.clientHeight, window.devicePixelRatio || 1);
        const config: ParsedCharacterConfig = { kind: 'vrm', poseTree: null, vrm: settingsRef.current };
        await driver.load(config, { resolveAsset: fetchAuthedBytes, signal: controller.signal });
        if (cancelled) return;
        setState('ready');
        onErrorRef.current?.(null);
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        setFailure(message);
        setState('failed');
        onErrorRef.current?.(message);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every other change: no reload.
  useEffect(() => {
    if (state === 'ready') driverRef.current?.configure(settings);
  }, [settings, state]);

  // The frame loop, fed by the buttons.
  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    let speakingSince = 0;
    const tick = () => {
      const t = performance.now();
      const dt = t - last;
      last = t;
      const driver = driverRef.current;
      if (driver) {
        const { speaking: isSpeaking, thinking: isThinking } = inputRef.current;
        if (isSpeaking && !speakingSince) speakingSince = t;
        if (!isSpeaking) speakingSince = 0;
        const gestures = gesturesRef.current;
        gesturesRef.current = [];
        const cue = cueRef.current;
        cueRef.current = null;
        driver.update(dt, {
          amplitude: isSpeaking ? syntheticAmplitude(t - speakingSince) : 0,
          isPlaying: isSpeaking,
          isThinking,
          gestures,
          faces: [],
          cue,
        });
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) driverRef.current?.resize(rect.width, rect.height, window.devicePixelRatio || 1);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  // The driver outlives reloads; it goes with the preview.
  useEffect(() => () => {
    driverRef.current?.dispose();
    driverRef.current = null;
  }, []);

  return (
    <Box ref={boxRef} sx={{ position: 'absolute', inset: 0, overflow: 'hidden' }} data-testid="vrm-preview">
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
      {state !== 'ready' && (
        <Box sx={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, p: 3, textAlign: 'center' }}>
          {state === 'loading' && <CircularProgress size={28} />}
          {state === 'nogl' && <Typography color="text.secondary">A 3D character needs hardware graphics on this display.</Typography>}
          {state === 'failed' && (
            <Typography color="text.secondary" sx={{ maxWidth: 360 }}>
              {failure ?? 'The model could not be shown.'}
            </Typography>
          )}
        </Box>
      )}
    </Box>
  );
});
VrmPreview.displayName = 'VrmPreview';
