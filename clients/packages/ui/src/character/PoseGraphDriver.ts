/**
 * The 2D pose graph behind the driver contract (#238).
 *
 * `CanvasCompositor` is the engine and is not edited: it keeps its own render
 * loop, its own image and video fetching, its 400×600 backing store. This
 * adapter implements `CharacterDriver` over the compositor's existing public
 * surface — the three input fields, `setGestures`/`setFaces`,
 * `loadPoseTree`/`clearPose`, `start`/`stop`/`destroy` — so the surface that
 * holds it never asks which kind of character it is drawing. What the
 * contract adds that the compositor lacks: a readable refusal for a config it
 * cannot draw, abort and supersession of a load in flight, an idempotent
 * dispose, and no-op updates before a load or after a dispose.
 *
 * A "frame" here, for the conformance probe, is one update the adapter
 * forwarded while a pose was held; the compositor draws it on its own loop.
 */
import type { CharacterDriver, DriverInput, DriverLoadDeps, ParsedCharacterConfig, PoseTree } from '@kurisu/models';
import { config } from '@kurisu/api';
import { CanvasCompositor } from '../videocall/engine/CanvasCompositor';

/** The backing store every 2D character is composited at; CSS scales it to the box. */
export const POSE_CANVAS_WIDTH = 400;
export const POSE_CANVAS_HEIGHT = 600;

export interface PoseGraphDriverOptions {
  /** Where the tree's root-relative asset URLs resolve; defaults to the configured backend. */
  apiBaseUrl?: () => string;
  /** A test hands in a compositor over a fake context. */
  compositorFactory?: (canvas: HTMLCanvasElement) => CanvasCompositor;
}

export interface PoseGraphDriver extends CharacterDriver {
  readonly kind: 'pose_graph';
  /** A tree is held and would be drawn. */
  readonly loaded: boolean;
  /** Updates forwarded while a tree was held. */
  readonly framesForwarded: number;
  /** The mouth's drive this frame, 0 unless audio plays. */
  readonly mouthOpen: number;
}

function abortError(): Error {
  const e = new Error('The character load was aborted.');
  e.name = 'AbortError';
  return e;
}

export function createPoseGraphDriver(canvas: HTMLCanvasElement, options: PoseGraphDriverOptions = {}): PoseGraphDriver {
  canvas.width = POSE_CANVAS_WIDTH;
  canvas.height = POSE_CANVAS_HEIGHT;
  const compositor = (options.compositorFactory ?? ((c) => new CanvasCompositor(c)))(canvas);
  compositor.start();
  const baseUrl = options.apiBaseUrl ?? (() => config.apiBaseUrl);

  let tree: PoseTree | null = null;
  let disposed = false;
  let frames = 0;
  // Loads run one at a time, in order; a load that a newer one overtook
  // rejects as aborted rather than applying a stale tree over a fresh one.
  let loadSeq = 0;
  let previous: Promise<unknown> = Promise.resolve();

  const empty = () => {
    tree = null;
    compositor.clearPose();
  };

  const load = async (character: ParsedCharacterConfig, deps: DriverLoadDeps): Promise<void> => {
    if (disposed) throw new Error('This character driver has been disposed.');
    if (deps.signal.aborted) throw abortError();
    const seq = ++loadSeq;
    const mine = previous.then(async () => {
      if (seq !== loadSeq || deps.signal.aborted) throw abortError();
      if (character.kind !== 'pose_graph') {
        empty();
        throw new Error("This driver draws pose graphs; the persona's character is a VRM model.");
      }
      if (!character.poseTree) {
        empty();
        throw new Error('This persona has no pose graph to draw.');
      }
      try {
        await compositor.loadPoseTree(character.poseTree, baseUrl());
      } catch (error) {
        if (seq === loadSeq) empty();
        throw error;
      }
      if (seq !== loadSeq) throw abortError();
      if (deps.signal.aborted || disposed) {
        empty();
        throw abortError();
      }
      tree = character.poseTree;
    });
    previous = mine.catch(() => undefined);
    return mine;
  };

  return {
    kind: 'pose_graph',
    get loaded() { return tree !== null && !disposed; },
    get framesForwarded() { return frames; },
    get mouthOpen() { return compositor.isAudioPlaying ? compositor.mouthAmplitude : 0; },
    load,
    update(_dtMs: number, input: DriverInput) {
      if (disposed || !tree) return;
      compositor.mouthAmplitude = input.amplitude;
      compositor.isAudioPlaying = input.isPlaying;
      compositor.isThinking = input.isThinking;
      if (input.gestures.length > 0) compositor.setGestures(input.gestures);
      compositor.setFaces(input.faces);
      frames++;
    },
    resize() {
      // The compositor draws at a fixed backing store and the canvas is
      // scaled by CSS to fit its box; nothing to do here.
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      tree = null;
      compositor.destroy();
    },
  };
}
