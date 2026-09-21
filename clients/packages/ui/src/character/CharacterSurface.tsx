/**
 * One persona's character, drawn by whichever driver its config calls for (#238).
 *
 * The surface owns the box, the clock and the live feed; the driver owns the
 * character. Every frame the surface samples the feed store — the mouth from
 * the spoken sentence's curve on its own clock, thinking, the gesture burst
 * it has not yet taken, the faces in view — and hands the driver one
 * `DriverInput`. It never asks which kind it holds after choosing the driver,
 * which is how the character window, the inline panel (#241) and the page an
 * Android WebView hosts (#245) draw the same thing.
 *
 * Only the pose graph has a driver here; a VRM persona shows "No avatar"
 * until #240 mounts `@kurisu/vrm` behind the same seam.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  characterFingerprint,
  createSpeechClockState,
  sampleSpeech,
  type CharacterDriver,
  type ParsedCharacterConfig,
} from '@kurisu/models';
import { fetchAuthedBytes } from '@kurisu/api';
import { characterFeed, takeGestures } from '@kurisu/state';
import { createPoseGraphDriver } from './PoseGraphDriver';

export interface CharacterSurfaceProps {
  character: ParsedCharacterConfig | null;
  /** This persona is speaking: it hears the sentence and the thinking state. */
  active: boolean;
  /** Gestures and faces reach it — the active persona, or everyone while nobody is. */
  receivesStimuli: boolean;
  /**
   * Bumped by the host when a session carrying a token arrives. A load that
   * failed — a 401 the session round trip did not answer in time, a network
   * blip — is retried on the next bump; a load that succeeded ignores it, so a
   * routine token refresh never reloads the art (#237).
   */
  retryToken?: number;
  /** A test hands in a driver over fakes. */
  makeDriver?: (character: ParsedCharacterConfig, canvas: HTMLCanvasElement) => CharacterDriver | null;
  /** The clock the feed's timestamps are on (`Date.now`). */
  now?: () => number;
}

/** The feed's timestamps are `Date.now()` values; one instance, so the loop effect is stable. */
const wallClock = () => Date.now();

function defaultMakeDriver(character: ParsedCharacterConfig, canvas: HTMLCanvasElement): CharacterDriver | null {
  if (character.kind === 'pose_graph' && character.poseTree) return createPoseGraphDriver(canvas);
  return null;
}

/** Whether any driver here can draw this config. */
export function drawable(character: ParsedCharacterConfig | null): boolean {
  return character?.kind === 'pose_graph' && character.poseTree !== null;
}

export const CharacterSurface: React.FC<CharacterSurfaceProps> = ({
  character,
  active,
  receivesStimuli,
  retryToken = 0,
  makeDriver = defaultMakeDriver,
  now = wallClock,
}) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const driverRef = useRef<CharacterDriver | null>(null);
  const loadFailedRef = useRef(false);
  const loadedRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const inputsRef = useRef({ active, receivesStimuli });
  inputsRef.current = { active, receivesStimuli };

  const fingerprint = useMemo(() => characterFingerprint(character), [character]);
  const canDraw = drawable(character);

  // One driver per mounted canvas; StrictMode's double mount makes two, each
  // disposed by its own cleanup.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !character || !canDraw) return;
    const driver = makeDriver(character, canvas);
    driverRef.current = driver;
    loadedRef.current = null;
    loadFailedRef.current = false;
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      driver?.dispose();
      driverRef.current = null;
      loadedRef.current = null;
    };
    // The driver is remade only when the canvas is: a config change is a load, below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canDraw, makeDriver]);

  // Load when the config's content changes, and again after a failure once a
  // session arrives. `retryToken` is in the deps so the effect runs on a bump;
  // the guard makes a bump a no-op unless the last load failed.
  useEffect(() => {
    const driver = driverRef.current;
    if (!driver || !character) return;
    const changed = fingerprint !== loadedRef.current;
    if (!changed && !loadFailedRef.current) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    loadedRef.current = fingerprint;
    loadFailedRef.current = false;
    setLoadError(null);
    driver.load(character, { resolveAsset: fetchAuthedBytes, signal: controller.signal }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      loadFailedRef.current = true;
      setLoadError(error instanceof Error ? error.message : String(error));
      console.error('[CharacterSurface] Failed to load the character:', error);
    });
  }, [character, fingerprint, retryToken]);

  // The frame loop: sample the feed, drive the driver. Refs, not state, so
  // nothing re-renders at frame rate.
  useEffect(() => {
    if (!canDraw) return;
    const clock = createSpeechClockState();
    let lastSeq = characterFeed.gestures.current.seq;
    let last = now();
    let frame = 0;
    const tick = () => {
      const t = now();
      const dt = t - last;
      last = t;
      const driver = driverRef.current;
      if (driver) {
        const { active: isActive, receivesStimuli: stimuli } = inputsRef.current;
        const speech = sampleSpeech(
          isActive ? characterFeed.speech.current : null,
          isActive ? characterFeed.speechSync.current : null,
          t,
          clock,
        );
        let gestures: string[] = [];
        if (stimuli) {
          const burst = takeGestures(lastSeq);
          gestures = burst.names;
          lastSeq = burst.seq;
        } else {
          // Not listening: let the bursts go by rather than replaying them later.
          lastSeq = characterFeed.gestures.current.seq;
        }
        driver.update(dt, {
          amplitude: speech.amplitude,
          isPlaying: speech.isPlaying,
          isThinking: isActive && characterFeed.thinking.current,
          gestures,
          faces: stimuli ? characterFeed.faces.current : [],
          cue: null,
        });
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [canDraw, now]);

  // Tell the driver the box it has, in CSS pixels and the device's ratio.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !canDraw || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) driverRef.current?.resize(rect.width, rect.height, window.devicePixelRatio || 1);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [canDraw]);

  return (
    <div
      ref={boxRef}
      data-testid="character-surface"
      style={{ flex: 1, minHeight: 0, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
    >
      {canDraw ? (
        <canvas
          ref={canvasRef}
          style={{ display: 'block', maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          title={loadError ?? undefined}
        />
      ) : (
        <span style={{ color: 'rgba(0,0,0,0.3)', fontSize: 14 }}>No avatar</span>
      )}
    </div>
  );
};
