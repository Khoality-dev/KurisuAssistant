/**
 * The contract between a character surface and whatever draws the character.
 *
 * A surface — the desktop's character window, an inline panel, the page an
 * Android WebView hosts — owns the box, the clock and the live feed. A driver
 * owns one persona's character: it loads the assets, moves the mouth, blinks,
 * reacts, and draws. The two meet here, so the surface never asks which kind
 * it is holding and a driver never asks which host it is in (#239).
 *
 * Nothing in this file names a canvas, a DOM type or a rendering library: the
 * `@kurisu/vrm` driver and the 2D pose-graph adapter both implement it, and the
 * conformance cases in `@kurisu/vrm/testing` run against either.
 */
import type { CharacterKind, ParsedCharacterConfig, VrmEmotion } from './character';

/**
 * A change of feeling the character should show now.
 *
 * `hold_ms` bounds it; without one the feeling holds until the next cue, or
 * until speech ends (the TTS queue keeps `isPlaying` up across sentences and
 * drops it once at the end, so "end of speech" is one edge, not one per
 * sentence). `weight` scales it, for a reaction that wants a half smile.
 */
export interface EmotionCue {
  emotion: VrmEmotion;
  hold_ms?: number | null;
  weight?: number;
}

/**
 * Everything the character reacts to, sampled once per frame by the surface.
 *
 * `amplitude` is the mouth's drive, 0..1, meaningful only while `isPlaying`;
 * the surface derives it from the spoken sentence's curve on its own clock.
 * `gestures` are one-shot: the surface hands them over once and the driver
 * treats them as consumed by this update. `faces` is level state. `cue` is a
 * cue new this frame, else null.
 */
export interface DriverInput {
  amplitude: number;
  isPlaying: boolean;
  isThinking: boolean;
  gestures: string[];
  faces: string[];
  cue: EmotionCue | null;
}

/** What a driver may ask of its host while loading. */
export interface DriverLoadDeps {
  /** The bytes behind a root-relative asset URL, fetched with whatever auth the host holds. */
  resolveAsset: (url: string) => Promise<ArrayBuffer>;
  /** Aborted when the surface moves on (persona switch, unmount) before the load finishes. */
  signal: AbortSignal;
}

/**
 * One persona's character, behind one surface-agnostic interface.
 *
 * Lifecycle: `load` (again, to switch persona), any number of `update`s at the
 * surface's frame rate, `resize` whenever the box changes, `dispose` once — but
 * `dispose` is idempotent and `update` before `load` or after `dispose` is a
 * no-op, because React StrictMode mounts twice and a surface may tear down
 * while a load is in flight.
 */
export interface CharacterDriver {
  readonly kind: CharacterKind;
  /** Rejects with a readable message; a rejected load leaves the driver empty, not broken. */
  load(config: ParsedCharacterConfig, deps: DriverLoadDeps): Promise<void>;
  /** `dtMs` is wall-clock milliseconds since the last update; a driver clamps it itself. */
  update(dtMs: number, input: DriverInput): void;
  /** CSS pixels and the device pixel ratio; the driver sizes its own backing store. */
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void;
  dispose(): void;
}
