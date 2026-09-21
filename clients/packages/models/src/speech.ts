/**
 * One spoken sentence, as the character feed carries it.
 *
 * The producer (the TTS queue) already computes an RMS curve for every
 * sentence before playing it. Pushing that curve once, with the moment
 * playback actually began, lets every surface — a second window, an inline
 * panel, an Android WebView — derive the mouth amplitude on its own clock
 * instead of being fed a number thirty times a second across a process
 * boundary that throttles when the main window is hidden (#238, #246).
 */
import type { VrmEmotion } from './character';

export interface SpeechSegment {
  text: string;
  /** `Date.now()` taken when playback began — the audio element's `playing`
   *  event, or after `MediaPlayer.start()` returned — never before `play()`. */
  startedAt: number;
  durationMs: number;
  /** The curve's own window, in milliseconds (`floor(sampleRate / 30) / sampleRate` s). */
  windowMs: number;
  /** RMS per window, 0..1; null when synthesis failed and the surface holds a silent mouth for `durationMs`. */
  curve: number[] | null;
  /** Feelings to show while this sentence plays, at their offset into it. */
  cues: Array<{ emotion: VrmEmotion; delayMs: number }>;
}

/**
 * A low-rate correction from the producer's own playback position, so output
 * buffering on a phone is absorbed within the first sync rather than
 * accumulated over a long sentence.
 */
export interface SpeechSync {
  positionMs: number;
  /** `Date.now()` when `positionMs` was read. */
  at: number;
}
