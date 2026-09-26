/**
 * One persona's character, drawn by whichever driver its config calls for (#238).
 *
 * The surface owns the box, the clock and the live feed; the driver owns the
 * character. Every frame the surface samples the feed store — the mouth from
 * the spoken sentence's curve on its own clock, thinking, the gesture burst
 * it has not yet taken, the faces in view, and a feeling: the spoken
 * sentence's when the audio reaches it, or one shown outside speech for this
 * persona (#244) — and hands the driver one `DriverInput`. It never asks which kind it holds after choosing the driver,
 * which is how the character window, the inline panel (#241) and the page an
 * Android WebView hosts (#245) draw the same thing.
 *
 * A VRM persona (#240) is drawn by `@kurisu/vrm`, imported only when a VRM
 * persona is on screen and only after `supportsWebGL` has said this display
 * can draw one: the engine is three.js, and neither a 2D-only user's bundle
 * nor a machine without hardware graphics should pay for it. While the model
 * downloads the surface says how far it has got; when the download fails it
 * says so and tries again when the connection or the session comes back.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, LinearProgress, Typography } from '@mui/material';
import { ErrorOutline as ErrorIcon, ViewInAr as ModelIcon } from '@mui/icons-material';
import {
  characterFingerprint,
  createSegmentCueState,
  createSpeechClockState,
  sampleSpeech,
  takeSegmentCue,
  type CharacterDriver,
  type ParsedCharacterConfig,
} from '@kurisu/models';
import { fetchAuthedBytes } from '@kurisu/api';
import { characterFeed, takeEmotion, takeGestures } from '@kurisu/state';
import { supportsWebGL } from '@kurisu/vrm/probe';
import { createPoseGraphDriver } from './PoseGraphDriver';

/** The part of `@kurisu/vrm` the surface needs; a type only, so nothing is imported until a VRM persona appears. */
export type VrmModule = Pick<typeof import('@kurisu/vrm'), 'createVrmDriver'>;

export interface MakeDriverDeps {
  /** Loads the VRM engine. The surface's own prop, so a test can see it was never asked. */
  importVrm: () => Promise<VrmModule>;
}

export type MakeDriver = (
  character: ParsedCharacterConfig,
  canvas: HTMLCanvasElement,
  deps: MakeDriverDeps,
) => CharacterDriver | null | Promise<CharacterDriver | null>;

export interface CharacterSurfaceProps {
  character: ParsedCharacterConfig | null;
  /** Whose character this is: a feeling shown outside speech names the face it is for (#244). */
  personaId?: number | null;
  /** The persona's name, for the sentence that says where to upload a model. */
  personaName?: string;
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
  makeDriver?: MakeDriver;
  /** A test hands in a spy, to see the engine is not loaded where it cannot draw. */
  importVrm?: () => Promise<VrmModule>;
  /** Whether this display can draw 3D; `supportsWebGL` unless a test says otherwise. */
  probe?: () => boolean;
  /** The clock the feed's timestamps are on (`Date.now`). */
  now?: () => number;
}

/** What the surface is showing. Only a VRM persona shows `loading` and `failed`; a pose graph draws as its art arrives. */
export type SurfaceStatus = 'idle' | 'loading' | 'ready' | 'failed' | 'nogl';

/** The words on screen, in one place so a test and a translator can find them. */
export const SURFACE_TEXT = {
  noAvatar: 'No avatar',
  loading: 'Loading 3D model',
  noModelTitle: 'No 3D model yet',
  noModelBody: (name: string) => `Upload one in Settings → Personas → ${name} → Set up 3D character.`,
  noGl: 'A 3D character needs hardware graphics on this display',
  failedGeneric: 'Something went wrong loading the 3D model.',
  failedTitle: (file: string) => `Couldn’t load ${file}`,
  failedNetwork: 'The download stopped before the whole file arrived. The window tries again when the connection comes back.',
  failedMissing: 'The server has no file for this model any more. Upload it again in the persona’s 3D setup.',
  tryAgain: 'Try again',
} as const;

/** The feed's timestamps are `Date.now()` values; one instance, so the loop effect is stable. */
const wallClock = () => Date.now();

const importVrmEngine = (): Promise<VrmModule> => import('@kurisu/vrm');

function defaultMakeDriver(character: ParsedCharacterConfig, canvas: HTMLCanvasElement, deps: MakeDriverDeps): CharacterDriver | null | Promise<CharacterDriver | null> {
  if (character.kind === 'pose_graph' && character.poseTree) return createPoseGraphDriver(canvas);
  if (character.kind === 'vrm' && character.vrm?.model) {
    // The canvas is keyed by kind below, so it leaves the document with this
    // driver: its context may be released with it.
    return deps.importVrm().then((m) => m.createVrmDriver(canvas, { releaseContextOnDispose: true }));
  }
  return null;
}

/** Whether any driver here can draw this config: a pose graph with a tree, or a VRM persona with a model. */
export function drawable(character: ParsedCharacterConfig | null): boolean {
  if (character?.kind === 'pose_graph') return character.poseTree !== null;
  if (character?.kind === 'vrm') return !!character.vrm?.model;
  return false;
}

/** The model's file name as the user uploaded it, when the server recorded one. */
function modelFileName(character: ParsedCharacterConfig | null): string {
  const model = character?.vrm?.model as { filename?: unknown } | null | undefined;
  return typeof model?.filename === 'string' && model.filename ? model.filename : 'the 3D model';
}

/**
 * The sentence under "Couldn’t load …". Only a failure of the connection
 * itself — `fetch` rejecting with a `TypeError`, or a body cut short — is
 * promised a retry when the connection comes back; a refusal (401/403/5xx),
 * an engine chunk that would not load or a renderer that would not start is
 * not a network problem and is not described as one.
 */
export function failureBody(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { name?: string; message?: string; status?: number };
    // By name, not `instanceof`: importing the class would carry the engine into this chunk.
    if (e.name === 'VrmLoadError' && e.message) return e.message;
    if (e.name === 'AssetRequestError' && e.status === 404) return SURFACE_TEXT.failedMissing;
    if (e.name === 'DownloadInterruptedError' || error instanceof TypeError) return SURFACE_TEXT.failedNetwork;
  }
  return SURFACE_TEXT.failedGeneric;
}

const MB = 1_000_000;
const mb = (bytes: number) => (bytes / MB).toFixed(1);

/** Reports progress to React at most this often; a 60 MB body arrives in a thousand chunks. */
const PROGRESS_INTERVAL_MS = 100;

type NoDrag = React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' };

export const CharacterSurface: React.FC<CharacterSurfaceProps> = ({
  character,
  personaId = null,
  personaName = 'this persona',
  active,
  receivesStimuli,
  retryToken = 0,
  makeDriver = defaultMakeDriver,
  importVrm = importVrmEngine,
  probe = supportsWebGL,
  now = wallClock,
}) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const driverRef = useRef<CharacterDriver | null>(null);
  const loadFailedRef = useRef(false);
  const loadedRef = useRef<string | null>(null);
  // The driver has the character loaded: a feeling handed over before then
  // would be dropped, so one that arrives early waits for this.
  const drawnRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [status, setStatus] = useState<SurfaceStatus>('idle');
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  // Bumped when an asynchronously made driver arrives, so the load runs against it.
  const [driverVersion, setDriverVersion] = useState(0);
  // Bumped by "Try again" and by the connection coming back, when there is a driver to load again.
  const [manualRetry, setManualRetry] = useState(0);
  // Bumped by the same paths when there is no driver: the engine's chunk or the
  // driver itself failed to arrive (a stale chunk after a redeploy 404s), and
  // re-running the load would find nothing to load with.
  const [engineAttempt, setEngineAttempt] = useState(0);
  const inputsRef = useRef({ active, receivesStimuli, personaId });
  inputsRef.current = { active, receivesStimuli, personaId };
  // Read when a driver is made, not a reason to remake one: a host passing an
  // inline function must not tear the stage down on every render.
  const engineRef = useRef({ importVrm, probe });
  engineRef.current = { importVrm, probe };

  const fingerprint = useMemo(() => characterFingerprint(character), [character]);
  const canDraw = drawable(character);
  const kind = character?.kind ?? null;
  const isVrm = kind === 'vrm';

  // One driver per mounted canvas; StrictMode's double mount makes two, each
  // disposed by its own cleanup. A VRM driver arrives after the engine's
  // chunk does, and only if the display passed the probe first.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !character || !canDraw) return;
    let cancelled = false;
    let driver: CharacterDriver | null = null;
    const adopt = (made: CharacterDriver | null) => {
      if (cancelled) {
        made?.dispose();
        return;
      }
      driver = made;
      driverRef.current = made;
      drawnRef.current = false;
      loadedRef.current = null;
      loadFailedRef.current = false;
      setDriverVersion((v) => v + 1);
    };
    const refuse = (error: unknown) => {
      if (cancelled) return;
      loadFailedRef.current = true;
      setLoadError(error);
      setStatus('failed');
      console.error('[CharacterSurface] Failed to start the character:', error);
    };

    const { importVrm: loadEngine, probe: canDraw3d } = engineRef.current;
    if (character.kind === 'vrm' && !canDraw3d()) {
      setStatus('nogl');
    } else {
      if (character.kind === 'vrm') setStatus('loading');
      try {
        const made = makeDriver(character, canvas, { importVrm: loadEngine });
        if (made instanceof Promise) made.then(adopt, refuse);
        else adopt(made);
      } catch (error) {
        refuse(error);
      }
    }
    return () => {
      cancelled = true;
      abortRef.current?.abort();
      abortRef.current = null;
      driver?.dispose();
      driverRef.current = null;
      drawnRef.current = false;
      loadedRef.current = null;
      setStatus('idle');
    };
    // The driver is remade only when the canvas is: a config change is a load, below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canDraw, kind, makeDriver, engineAttempt]);

  // Load when the config's content changes, and again after a failure once a
  // session arrives or the user asks. `retryToken` and `manualRetry` are in
  // the deps so the effect runs on a bump; the guard makes a bump a no-op
  // unless the last load failed.
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
    drawnRef.current = false;
    setLoadError(null);

    const model = character.kind === 'vrm' ? character.vrm?.model ?? null : null;
    let reportedAt = 0;
    const onModelProgress = (received: number, total: number | null) => {
      const t = Date.now();
      const expected = total ?? model?.bytes ?? 0;
      if (received < expected && t - reportedAt < PROGRESS_INTERVAL_MS) return;
      reportedAt = t;
      if (!controller.signal.aborted) setProgress({ received, total: expected });
    };
    if (character.kind === 'vrm') {
      setStatus('loading');
      setProgress(model ? { received: 0, total: model.bytes } : null);
    }

    const resolveAsset = (url: string) =>
      fetchAuthedBytes(url, { signal: controller.signal }, model && url === model.url ? onModelProgress : undefined);

    driver.load(character, { resolveAsset, signal: controller.signal }).then(
      () => {
        if (controller.signal.aborted) return;
        drawnRef.current = true;
        setStatus(character.kind === 'vrm' ? 'ready' : 'idle');
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        loadFailedRef.current = true;
        setLoadError(error);
        if (character.kind === 'vrm') setStatus('failed');
        console.error('[CharacterSurface] Failed to load the character:', error);
      },
    );
  }, [character, fingerprint, retryToken, manualRetry, driverVersion]);

  // Every retry path lands here: load again with the driver there is, or, if
  // making the driver is what failed, make it again.
  const retry = () => {
    if (driverRef.current) setManualRetry((n) => n + 1);
    else setEngineAttempt((n) => n + 1);
  };
  const retryRef = useRef(retry);
  retryRef.current = retry;

  // A session carrying a token arrived. The load effect retries a failed load
  // by itself; a driver that never arrived needs making again.
  useEffect(() => {
    if (loadFailedRef.current && !driverRef.current) setEngineAttempt((n) => n + 1);
  }, [retryToken]);

  // A failed download tries again when the connection comes back.
  useEffect(() => {
    if (status !== 'failed' || typeof window === 'undefined') return;
    const retry = () => retryRef.current();
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [status]);

  // The frame loop: sample the feed, drive the driver. Refs, not state, so
  // nothing re-renders at frame rate.
  useEffect(() => {
    if (!canDraw) return;
    const clock = createSpeechClockState();
    const segmentCues = createSegmentCueState();
    let lastSeq = characterFeed.gestures.current.seq;
    // Not the current seq: a feeling pushed before this surface mounted (the
    // one a reopened conversation rests on) is still taken if it holds.
    let lastEmotionSeq = 0;
    let last = now();
    let frame = 0;
    const tick = () => {
      const t = now();
      const dt = t - last;
      last = t;
      const driver = driverRef.current;
      if (driver) {
        const { active: isActive, receivesStimuli: stimuli, personaId: whose } = inputsRef.current;
        const segment = isActive ? characterFeed.speech.current : null;
        const speech = sampleSpeech(
          segment,
          isActive ? characterFeed.speechSync.current : null,
          t,
          clock,
        );
        // The spoken sentence's feeling, when the audio reaches it.
        let cue = takeSegmentCue(segment, speech.positionMs, segmentCues);
        // A feeling shown outside speech, once, on the face it names — or on
        // whoever takes stimuli when it names none. Left waiting while the
        // character is still loading, or for the next frame when a spoken
        // one landed on this one.
        if (drawnRef.current && !cue) {
          const burst = takeEmotion(lastEmotionSeq, t);
          lastEmotionSeq = burst.seq;
          const mine = burst.personaId === null ? stimuli : burst.personaId === whose;
          if (burst.cue && mine) cue = burst.cue;
        }
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
          cue,
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
  }, [canDraw, driverVersion]);

  const noModel = isVrm && !character?.vrm?.model;
  const backdrop = isVrm ? character?.vrm?.camera?.background ?? '#ffffff' : undefined;

  const boxStyle: NoDrag = {
    flex: 1,
    minHeight: 0,
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
    ...(isVrm
      ? {
          background: backdrop,
          // The character window is a drag region; over a 3D stage that would
          // swallow every pointer event, so this box opts out (the window
          // keeps a drag strip along its top edge).
          WebkitAppRegion: 'no-drag',
        }
      : {}),
  };

  const showCanvas = canDraw && status !== 'nogl';

  return (
    <div ref={boxRef} data-testid="character-surface" data-status={noModel ? 'no-model' : status} style={boxStyle}>
      {showCanvas && (
        <canvas
          // A 2D context and a WebGL one cannot share a canvas: a kind change is a new element.
          key={kind ?? 'none'}
          ref={canvasRef}
          style={
            isVrm
              ? { display: 'block', width: '100%', height: '100%' }
              : { display: 'block', maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }
          }
          title={!isVrm && loadError ? String((loadError as Error)?.message ?? loadError) : undefined}
        />
      )}

      {noModel && (
        <Notice icon={<ModelIcon />} title={SURFACE_TEXT.noModelTitle} body={SURFACE_TEXT.noModelBody(personaName)} />
      )}

      {isVrm && status === 'nogl' && <Notice icon={<ModelIcon />} title={SURFACE_TEXT.noGl} />}

      {isVrm && !noModel && status === 'loading' && (
        <Notice icon={<ModelIcon />} title={SURFACE_TEXT.loading} background={backdrop}>
          <LinearProgress
            variant={progress && progress.total > 0 ? 'determinate' : 'indeterminate'}
            value={progress && progress.total > 0 ? Math.min(100, (progress.received / progress.total) * 100) : undefined}
            sx={{ width: 180, borderRadius: 2, mt: 1 }}
          />
          {progress && progress.total > 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, fontVariantNumeric: 'tabular-nums' }}>
              {`${mb(progress.received)} of ${mb(progress.total)} MB`}
            </Typography>
          )}
        </Notice>
      )}

      {isVrm && !noModel && status === 'failed' && (
        <Notice
          icon={<ErrorIcon color="error" />}
          title={SURFACE_TEXT.failedTitle(modelFileName(character))}
          body={failureBody(loadError)}
          background={backdrop}
        >
          <Button size="small" variant="outlined" sx={{ mt: 1.5 }} onClick={retry}>
            {SURFACE_TEXT.tryAgain}
          </Button>
        </Notice>
      )}

      {!canDraw && !isVrm && (
        <span style={{ color: 'rgba(0,0,0,0.3)', fontSize: 14 }}>{SURFACE_TEXT.noAvatar}</span>
      )}
    </div>
  );
};

/** A centred message over the stage: an icon, a line, an optional sentence and whatever else. */
const Notice: React.FC<{
  icon: React.ReactNode;
  title: string;
  body?: string;
  background?: string;
  children?: React.ReactNode;
}> = ({ icon, title, body, background, children }) => (
  <Box
    sx={{
      position: 'absolute',
      inset: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      textAlign: 'center',
      px: 3,
      gap: 0.5,
      background: background ?? 'transparent',
      color: 'text.secondary',
      '& > svg': { fontSize: 32, opacity: 0.7 },
    }}
  >
    {icon}
    <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.primary' }}>
      {title}
    </Typography>
    {body && (
      <Typography variant="caption" sx={{ maxWidth: 280, lineHeight: 1.45 }}>
        {body}
      </Typography>
    )}
    {children}
  </Box>
);
