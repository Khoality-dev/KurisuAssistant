/**
 * The character page's own surface: what `CharacterSurface` is on the desktop,
 * minus React and the store (#245).
 *
 * A native host pushes messages (`host.ts`); this keeps the latest of each as
 * the feed, loads the persona's model through the host's same-origin
 * `/character-assets/` URLs, and once a frame samples the feed into the
 * driver. No DOM here — `main.ts` owns the canvas, the frame loop and the
 * native callbacks — so every rule the page follows runs under happy-dom
 * against a fake driver.
 *
 * Cues ride the sentence that carries them: a cue fires once, on the first
 * frame the speech clock's position passes its `delayMs`. The resting emotion
 * is the face between cues, so it becomes the driver's `default_expression`.
 */
import type { DriverInput, ParsedCharacterConfig, SpeechSegment, SpeechSync, VrmEmotion, VrmSettings } from '@kurisu/models';
import { createSpeechClockState, sampleSpeech } from '@kurisu/models';
import type { VrmDriver } from '../driver/VrmDriver';
import { HostMessageError, parseHostMessage, type PageEvent } from './host';

/** What the page needs of a driver: the contract, `configure`, and whether a frame reached the canvas. */
export type PageDriver = Pick<VrmDriver, 'load' | 'update' | 'resize' | 'dispose' | 'configure'> & {
  snapshot(): { framesDrawn: number };
};

/** Mirrors `CharacterSurface`'s `data-status`, plus `nogl`, which `main.ts` decides before any of this runs. */
export type PageStatus = 'idle' | 'loading' | 'ready' | 'failed' | 'no-model' | 'nogl';

export interface PageSubtitle {
  text: string;
  isUser: boolean;
  holdMs: number;
}

export interface PageRuntimeOptions {
  createDriver: () => PageDriver;
  /** The bytes behind a root-relative URL, from the page's own origin — where the host answers with the file. */
  fetchAsset: (url: string, signal: AbortSignal) => Promise<ArrayBuffer>;
  /** To the host: `ready`, `first-frame`, `error`. */
  emit: (event: PageEvent) => void;
  onStatus?: (status: PageStatus, detail: string | null) => void;
  onSubtitle?: (subtitle: PageSubtitle | null) => void;
}

export interface PageRuntime {
  readonly status: PageStatus;
  /** One message from the host, as a JSON string or an object. Never throws. */
  receive(raw: unknown): void;
  /** One frame, at wall-clock `now` (`Date.now()`: the speech segment is stamped on that clock). */
  frame(now: number): void;
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void;
  dispose(): void;
}

/** The character window's reading time when the host gives none: 350 ms a word, at least 1.5 s. */
export function subtitleHoldMs(text: string, durationMs: number | null): number {
  if (durationMs != null) return durationMs;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1500, words * 350);
}

/** What only a reload can change: the model and the clip files. */
function assetKeyOf(vrm: VrmSettings): string {
  return [vrm.model?.sha256 ?? '-', ...vrm.clips.map((c) => `${c.id}:${c.sha256}`)].join('|');
}

export function createPageRuntime(options: PageRuntimeOptions): PageRuntime {
  const { emit } = options;
  let status: PageStatus = 'idle';
  let disposed = false;

  let driver: PageDriver | null = null;
  let loadedKey: string | null = null;
  let loadController: AbortController | null = null;
  let loadGeneration = 0;
  let awaitingFirstFrame = false;
  let settings: VrmSettings | null = null;

  let segment: SpeechSegment | null = null;
  let sync: SpeechSync | null = null;
  let cueIndex = 0;
  const clock = createSpeechClockState();
  let isThinking = false;
  let faces: string[] = [];
  let pendingGestures: string[] = [];
  let lastGestureSeq = -Infinity;
  let resting: VrmEmotion | null = null;
  let lastFrameAt: number | null = null;
  let size: [number, number, number] | null = null;

  function setStatus(next: PageStatus, detail: string | null = null): void {
    status = next;
    options.onStatus?.(next, detail);
  }

  /** The persona's settings with the resting emotion as the face between cues. */
  function effective(vrm: VrmSettings): VrmSettings {
    return resting ? { ...vrm, emotion: { ...vrm.emotion, default_expression: resting } } : vrm;
  }

  function unload(): void {
    loadController?.abort();
    loadController = null;
    loadedKey = null;
    settings = null;
    awaitingFirstFrame = false;
    driver?.dispose();
    driver = null;
  }

  function applyConfig(character: ParsedCharacterConfig | null): void {
    const vrm = character?.kind === 'vrm' ? character.vrm : null;
    if (!vrm?.model) {
      unload();
      setStatus('no-model', character?.kind === 'pose_graph' ? 'This persona has a 2D character.' : null);
      return;
    }
    const key = assetKeyOf(vrm);
    settings = vrm;
    if (driver && key === loadedKey) {
      driver.configure(effective(vrm));
      return;
    }

    loadController?.abort();
    const controller = new AbortController();
    loadController = controller;
    loadedKey = key;
    awaitingFirstFrame = false;
    const generation = ++loadGeneration;
    if (!driver) {
      driver = options.createDriver();
      if (size) driver.resize(...size);
    }
    setStatus('loading');
    driver
      .load(
        { kind: 'vrm', poseTree: null, vrm: effective(vrm) },
        { resolveAsset: (url) => options.fetchAsset(url, controller.signal), signal: controller.signal },
      )
      .then(
        () => {
          if (disposed || generation !== loadGeneration) return;
          awaitingFirstFrame = true;
          setStatus('ready');
        },
        (error: unknown) => {
          if (disposed || generation !== loadGeneration || controller.signal.aborted) return;
          // A failed load leaves the driver empty, not broken: the next config loads again.
          loadedKey = null;
          const message = error instanceof Error ? error.message : String(error);
          setStatus('failed', message);
          emit({ t: 'error', code: 'load', message });
        },
      );
  }

  function receive(raw: unknown): void {
    if (disposed) return;
    let message;
    try {
      message = parseHostMessage(raw);
    } catch (error) {
      const text = error instanceof HostMessageError ? error.message : String(error);
      emit({ t: 'error', code: 'message', message: text });
      return;
    }
    switch (message.t) {
      case 'config':
        applyConfig(message.character);
        break;
      case 'speech':
        segment = message.segment
          ? { ...message.segment, cues: [...message.segment.cues].sort((a, b) => a.delayMs - b.delayMs) }
          : null;
        sync = null;
        cueIndex = 0;
        break;
      case 'speech-sync':
        sync = message.sync;
        break;
      case 'feed':
        isThinking = message.isThinking;
        break;
      case 'gestures':
        // A replayed burst (the host re-sends state on `ready`) is not a new wave.
        if (message.seq > lastGestureSeq) {
          lastGestureSeq = message.seq;
          pendingGestures = [...pendingGestures, ...message.names];
        }
        break;
      case 'faces':
        faces = message.names;
        break;
      case 'subtitle':
        options.onSubtitle?.({ text: message.text, isUser: message.isUser, holdMs: subtitleHoldMs(message.text, message.durationMs) });
        break;
      case 'resting':
        resting = message.emotion;
        if (driver && settings && loadedKey) driver.configure(effective(settings));
        break;
    }
  }

  function frame(now: number): void {
    if (disposed || !driver) return;
    const dt = lastFrameAt == null ? 0 : Math.max(0, now - lastFrameAt);
    lastFrameAt = now;

    const speech = sampleSpeech(segment, sync, now, clock);
    let cue: DriverInput['cue'] = null;
    if (segment && speech.isPlaying) {
      // Every cue the audio has passed since the last frame; the latest wins.
      while (cueIndex < segment.cues.length && segment.cues[cueIndex].delayMs <= speech.positionMs) {
        cue = { emotion: segment.cues[cueIndex].emotion, hold_ms: null };
        cueIndex++;
      }
    }
    const gestures = pendingGestures;
    pendingGestures = [];

    driver.update(dt, {
      amplitude: speech.amplitude,
      isPlaying: speech.isPlaying,
      isThinking,
      gestures,
      faces,
      cue,
    });

    if (awaitingFirstFrame && driver.snapshot().framesDrawn > 0) {
      awaitingFirstFrame = false;
      emit({ t: 'first-frame' });
    }
  }

  return {
    get status() {
      return status;
    },
    receive,
    frame,
    resize(w, h, dpr) {
      size = [w, h, dpr];
      driver?.resize(w, h, dpr);
    },
    dispose() {
      if (disposed) return;
      unload();
      disposed = true;
    },
  };
}
