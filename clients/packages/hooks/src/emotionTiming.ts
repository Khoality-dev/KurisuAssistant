/**
 * When a feeling reaches the face (#244).
 *
 * The backend reports each feeling the model wrote as a cue on the chunk whose
 * text starts where it takes effect: `emotion_at`, an offset into the current
 * LLM round's clean text, in UTF-16 code units (#243). Text streams seconds
 * ahead of speech, so applying a cue when it arrives would put the face out of
 * step with the voice. With speech on, a cue rides the sentence group the TTS
 * queue speaks it in, at its fraction of the way through, and the character
 * surface shows it when the audio gets there. With speech off, it shows as its
 * text arrives — debounced, the last of a quick run winning — and holds for
 * as long as its sentence would take to read.
 *
 * `StreamSpeechPlanner` is the streaming hook's whole speech side: it groups
 * the stream into sentences for the TTS queue (complete sentences, at least
 * ten words, narration stripped) exactly as the hook used to inline, and it
 * keeps the offsets honest. The backend restarts them with every round — a
 * tool call starts a new one — so a new bubble speaks whatever the last one
 * left unsaid as its own group and starts counting again from zero; without
 * that, a short tail of the first round would be prepended to the second and
 * every later cue would land that many characters early.
 *
 * Pure apart from its timer, which is injectable: the hook cannot be rendered
 * in this package's tests, so the logic lives here where it can be driven.
 */
import { stripNarration } from '@kurisu/api';
import type { EmotionCue, EmotionCueRecord, Message, VrmEmotion } from '@kurisu/models';

/** A feeling inside a sentence group, as a fraction of the way through it. */
export interface SegmentCue {
  emotion: VrmEmotion;
  atFraction: number;
}

/** How long a run of cues on arriving text is let settle; the last one wins. */
export const TEXT_CUE_DEBOUNCE_MS = 300;

/** The fewest words a sentence group must have before it is sent to the TTS queue. */
const MIN_WORDS_PER_GROUP = 10;

const SENTENCE_END = /(?<=[.!?。！？\n])\s*/;

/**
 * The cues of `[start, end)` of a round's text, as fractions of that span.
 *
 * When the span opens without a cue of its own, the feeling in force there —
 * the last cue before `start` — is put at its start, unless it is what the
 * previous group spoken already ended on. That covers a cue whose group was
 * never spoken (narration swallowed it) as well as the first group after one.
 */
export function selectCuesForSegment(
  cues: readonly EmotionCueRecord[],
  start: number,
  end: number,
  previousEnded: VrmEmotion | null,
): SegmentCue[] {
  if (end <= start) return [];
  const span = end - start;
  const inside = cues
    .filter((c) => c.at >= start && c.at < end)
    .sort((a, b) => a.at - b.at)
    .map((c) => ({ emotion: c.emotion, atFraction: (c.at - start) / span }));
  if (inside.length > 0 && inside[0].atFraction === 0) return inside;
  let inForce: VrmEmotion | null = null;
  let inForceAt = -1;
  for (const c of cues) {
    if (c.at < start && c.at >= inForceAt) { inForce = c.emotion; inForceAt = c.at; }
  }
  if (inForce && inForce !== previousEnded) return [{ emotion: inForce, atFraction: 0 }, ...inside];
  return inside;
}

/** How long a feeling shown on text arrival holds: its sentence's reading time, at least a second and a half. */
export function textCueHoldMs(text: string): number {
  const sentence = text.trimStart().split(SENTENCE_END)[0] ?? '';
  const words = sentence.trim() ? sentence.trim().split(/\s+/).length : 0;
  return Math.max(1500, words * 350);
}

/**
 * The feeling a reopened conversation rests on: the last cue of the last
 * assistant message, and whose face it was. Scroll-back replays nothing.
 */
export function restingCueOf(messages: readonly Message[]): { emotion: VrmEmotion; personaId: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const cues = m.emotion_cues;
    if (!m.persona_id || !cues || cues.length === 0) return null;
    return { emotion: cues[cues.length - 1].emotion, personaId: m.persona_id };
  }
  return null;
}

export interface StreamSpeechDeps {
  /** Speech is on: sentence groups go to the TTS queue and feelings ride them. */
  autoplay: () => boolean;
  /** One sentence group for the TTS queue, narration already stripped. */
  speak: (text: string, voice: string | undefined, cues: SegmentCue[]) => void;
  /** Speech is off: show a feeling on this persona's face now. */
  show: (cue: EmotionCue, personaId: number | null) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface StreamSpeechChunk {
  /** This chunk's text (an assistant chunk; tool chunks are never spoken). */
  content: string;
  emotion?: VrmEmotion | null;
  emotionAt?: number | null;
  personaId: number | null;
  voice?: string | null;
  /** The bubble's text so far, this chunk included. */
  runText: string;
}

export class StreamSpeechPlanner {
  private buffer = '';
  /** Where `buffer` starts in the round's text. */
  private consumed = 0;
  private cues: EmotionCueRecord[] = [];
  private previousEnded: VrmEmotion | null = null;
  private voice: string | undefined;
  private runText = '';
  private pendingText: { cue: EmotionCueRecord; personaId: number | null } | null = null;
  private timer: unknown = null;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: StreamSpeechDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /**
   * A new bubble: a new speaker, a tool, or the same persona after a tool.
   * What the last one left unsaid is spoken now as its own group, a feeling
   * still waiting to show shows, and the offsets start again from zero.
   */
  newRun(voice?: string | null): void {
    if (this.buffer.trim()) this.flush(this.buffer.length, this.buffer);
    this.showPendingNow();
    this.buffer = '';
    this.consumed = 0;
    this.cues = [];
    this.runText = '';
    this.voice = voice || undefined;
  }

  chunk(c: StreamSpeechChunk): void {
    this.runText = c.runText;
    if (c.voice) this.voice = c.voice;
    const cue = c.emotion && c.emotionAt != null ? { emotion: c.emotion, at: c.emotionAt } : null;

    if (!this.deps.autoplay()) {
      if (cue) this.showLater(cue, c.personaId);
      return;
    }

    if (cue) this.cues.push(cue);
    if (!c.content) return;
    this.buffer += c.content;
    // All but the last part are complete sentences.
    const parts = this.buffer.split(SENTENCE_END);
    if (parts.length < 2) return;
    const remainder = parts[parts.length - 1];
    const complete = parts.slice(0, -1).join(' ');
    // Fewer than ten words: keep accumulating.
    if (complete.trim().split(/\s+/).length < MIN_WORDS_PER_GROUP) return;
    // Measured on the raw buffer, before joining and stripping change lengths:
    // the offsets are into the text the backend counted.
    this.flush(this.buffer.length - remainder.length, complete);
    this.buffer = remainder;
  }

  /** The turn ended: speak what is left and show what is waiting. */
  done(): void {
    if (this.buffer.trim()) this.flush(this.buffer.length, this.buffer);
    this.showPendingNow();
    this.buffer = '';
    this.consumed = 0;
    this.cues = [];
    this.runText = '';
    this.voice = undefined;
  }

  /** Drop everything not yet said or shown: a cancel, a new send, a conversation switch. */
  reset(): void {
    this.cancelPending();
    this.buffer = '';
    this.consumed = 0;
    this.cues = [];
    this.previousEnded = null;
    this.runText = '';
    this.voice = undefined;
  }

  private flush(rawLength: number, text: string): void {
    const start = this.consumed;
    this.consumed += rawLength;
    const cues = selectCuesForSegment(this.cues, start, this.consumed, this.previousEnded);
    const cleaned = stripNarration(text);
    // A group narration swallowed is not spoken; its feeling stays in force
    // and opens the next group that is.
    if (!cleaned) return;
    this.deps.speak(cleaned, this.voice, cues);
    if (cues.length > 0) this.previousEnded = cues[cues.length - 1].emotion;
  }

  private showLater(cue: EmotionCueRecord, personaId: number | null): void {
    this.cancelTimer();
    this.pendingText = { cue, personaId };
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.showPendingNow();
    }, TEXT_CUE_DEBOUNCE_MS);
  }

  private showPendingNow(): void {
    this.cancelTimer();
    const pending = this.pendingText;
    this.pendingText = null;
    if (!pending) return;
    const hold = textCueHoldMs(this.runText.slice(pending.cue.at));
    this.deps.show({ emotion: pending.cue.emotion, hold_ms: hold }, pending.personaId);
  }

  private cancelPending(): void {
    this.cancelTimer();
    this.pendingText = null;
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
