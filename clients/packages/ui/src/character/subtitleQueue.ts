/**
 * The subtitle under a character: one sentence at a time, for as long as it
 * is spoken, and the user's line the moment it is sent (#238).
 *
 * This is the logic that lived inside `CharacterWindowApp`, lifted out so the
 * inline panel (#241) and the browser build show the same thing. The queue
 * knows nothing about React or the DOM: it takes the feed's subtitle events,
 * keeps its own timers through an injectable pair, and reports one view —
 * the text, whose it is, and whether it shows — whenever that changes.
 */
import type { SubtitleEvent } from '@kurisu/state';

export interface SubtitleView {
  text: string;
  isUser: boolean;
  visible: boolean;
}

export interface SubtitleTimers {
  set: (callback: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const realTimers: SubtitleTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Split on sentence ends, keeping each sentence's punctuation. */
export function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?。！？\n])\s*/).map((s) => s.trim()).filter(Boolean);
}

/** How long the user's own line stays up: a floor, then a per-word allowance. */
export function userHoldMs(text: string): number {
  const words = text.split(/\s+/).filter(Boolean);
  return Math.max(1500, words.length * 350);
}

/** How long the character's subtitle lingers after the last sentence. */
export const FADE_AFTER_LAST_MS = 1000;
/** The audio length assumed for a sentence whose synthesis failed. */
export const FALLBACK_DURATION_S = 4;

export class SubtitleQueue {
  private view: SubtitleView = { text: '', isUser: false, visible: false };
  private queue: Array<{ text: string; durationMs: number }> = [];
  private draining = false;
  private timer: unknown = null;

  constructor(
    private readonly onChange: (view: SubtitleView) => void,
    private readonly timers: SubtitleTimers = realTimers,
  ) {}

  /** What is showing now. */
  get current(): SubtitleView {
    return this.view;
  }

  handle(event: SubtitleEvent): void {
    if (!event.text) {
      // Cancel: clear everything and hide
      this.clearTimer();
      this.queue = [];
      this.draining = false;
      this.show({ ...this.view, visible: false });
      return;
    }

    if (event.isUser) {
      // User text: show immediately, interrupt the queue
      this.clearTimer();
      this.queue = [];
      this.draining = false;
      this.show({ text: event.text, isUser: true, visible: true });
      this.timer = this.timers.set(() => this.show({ ...this.view, visible: false }), userHoldMs(event.text));
      return;
    }

    // Persona text: split into sentences, spread the audio's length across
    // them, and let the drain handle the timing
    const chunkDurationMs = (event.duration || FALLBACK_DURATION_S) * 1000;
    const sentences = splitSentences(event.text);
    if (!sentences.length) return;
    const perSentenceMs = chunkDurationMs / sentences.length;
    for (const sentence of sentences) {
      this.queue.push({ text: sentence, durationMs: perSentenceMs });
    }
    if (!this.draining) this.drain();
  }

  dispose(): void {
    this.clearTimer();
    this.queue = [];
    this.draining = false;
  }

  /** Show one sentence for its duration, chain to the next, fade only after the last. */
  private drain = (): void => {
    if (this.queue.length === 0) {
      this.draining = false;
      this.timer = this.timers.set(() => this.show({ ...this.view, visible: false }), FADE_AFTER_LAST_MS);
      return;
    }
    this.draining = true;
    const item = this.queue.shift()!;
    this.show({ text: item.text, isUser: false, visible: true });
    this.timer = this.timers.set(this.drain, item.durationMs);
  };

  private show(view: SubtitleView): void {
    this.view = view;
    this.onChange(view);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
  }
}
