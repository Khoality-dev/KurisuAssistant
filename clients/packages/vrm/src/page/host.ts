/**
 * The message protocol between a native host and the character page.
 *
 * Android hosts the renderer in a WebView and, later, React Native in
 * `react-native-webview`; both push the same messages this module parses
 * (design §7.4). The shapes are the desktop feed's own — `SpeechSegment`,
 * `SpeechSync`, the persona's `character_config`, the vision signals, the
 * subtitle — so one renderer consumes identical data on every host. Every
 * message is validated here, because it crosses a trust boundary from Kotlin
 * (or from anything that can `postMessage`), and the golden fixtures under
 * `fixtures/` are the contract the Android JVM tests decode too.
 */
import type { SpeechSegment, SpeechSync, VrmEmotion } from '@kurisu/models';
import { parseCharacterConfig, VRM_EMOTIONS, type ParsedCharacterConfig } from '@kurisu/models';

export type HostMessage =
  | { t: 'config'; character: ParsedCharacterConfig | null; personaName: string | null }
  | { t: 'speech'; segment: SpeechSegment | null }
  | { t: 'speech-sync'; sync: SpeechSync }
  | { t: 'feed'; isThinking: boolean }
  | { t: 'gestures'; names: string[]; seq: number }
  | { t: 'faces'; names: string[] }
  | { t: 'subtitle'; text: string; isUser: boolean; durationMs: number | null }
  | { t: 'resting'; emotion: VrmEmotion };

export type HostMessageType = HostMessage['t'];

/** What the page tells the host back, through the three native callbacks. */
export type PageEvent = { t: 'ready' } | { t: 'first-frame' } | { t: 'error'; code: 'nogl' | 'load' | 'message'; message: string };

export class HostMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostMessageError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function stringList(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new HostMessageError(`${field} must be a list of strings`);
  return v as string[];
}

function finite(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new HostMessageError(`${field} must be a finite number`);
  return v;
}

function parseSegment(v: unknown): SpeechSegment {
  if (!isRecord(v)) throw new HostMessageError('segment must be an object');
  const text = typeof v.text === 'string' ? v.text : '';
  const startedAt = finite(v.startedAt, 'segment.startedAt');
  const durationMs = finite(v.durationMs, 'segment.durationMs');
  const windowMs = finite(v.windowMs, 'segment.windowMs');
  let curve: number[] | null = null;
  if (v.curve != null) {
    if (!Array.isArray(v.curve) || !v.curve.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      throw new HostMessageError('segment.curve must be a list of numbers or null');
    }
    curve = (v.curve as number[]).map((x) => (x < 0 ? 0 : x > 1 ? 1 : x));
  }
  const cues: SpeechSegment['cues'] = [];
  if (v.cues != null) {
    if (!Array.isArray(v.cues)) throw new HostMessageError('segment.cues must be a list');
    for (const c of v.cues) {
      if (!isRecord(c)) throw new HostMessageError('segment.cues[] must be objects');
      cues.push({ emotion: parseEmotion(c.emotion, 'segment.cues[].emotion'), delayMs: finite(c.delayMs, 'segment.cues[].delayMs') });
    }
  }
  return { text, startedAt, durationMs, windowMs, curve, cues };
}

function parseEmotion(v: unknown, field: string): VrmEmotion {
  if (typeof v !== 'string' || !(VRM_EMOTIONS as readonly string[]).includes(v)) {
    throw new HostMessageError(`${field} must be one of ${VRM_EMOTIONS.join(', ')}`);
  }
  return v as VrmEmotion;
}

/**
 * Turn whatever arrived (a string of JSON, or an already-parsed object) into
 * a typed message, or throw a `HostMessageError` naming the field.
 */
export function parseHostMessage(raw: unknown): HostMessage {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      throw new HostMessageError('message is not JSON');
    }
  }
  if (!isRecord(v) || typeof v.t !== 'string') throw new HostMessageError('message has no type');

  switch (v.t) {
    case 'config': {
      const personaName = typeof v.personaName === 'string' ? v.personaName : null;
      return { t: 'config', character: v.character == null ? null : parseCharacterConfig(v.character), personaName };
    }
    case 'speech':
      return { t: 'speech', segment: v.segment == null ? null : parseSegment(v.segment) };
    case 'speech-sync': {
      if (!isRecord(v.sync)) throw new HostMessageError('sync must be an object');
      return { t: 'speech-sync', sync: { positionMs: finite(v.sync.positionMs, 'sync.positionMs'), at: finite(v.sync.at, 'sync.at') } };
    }
    case 'feed':
      if (typeof v.isThinking !== 'boolean') throw new HostMessageError('isThinking must be a boolean');
      return { t: 'feed', isThinking: v.isThinking };
    case 'gestures':
      return { t: 'gestures', names: stringList(v.names, 'names'), seq: finite(v.seq, 'seq') };
    case 'faces':
      return { t: 'faces', names: stringList(v.names, 'names') };
    case 'subtitle': {
      if (typeof v.text !== 'string') throw new HostMessageError('text must be a string');
      const durationMs = v.durationMs == null ? null : finite(v.durationMs, 'durationMs');
      return { t: 'subtitle', text: v.text, isUser: v.isUser === true, durationMs };
    }
    case 'resting':
      return { t: 'resting', emotion: parseEmotion(v.emotion, 'emotion') };
    default:
      throw new HostMessageError(`unknown message type ${JSON.stringify(v.t)}`);
  }
}

/** The types a host may send, for a host-side exhaustiveness check. */
export const HOST_MESSAGE_TYPES: readonly HostMessageType[] = ['config', 'speech', 'speech-sync', 'feed', 'gestures', 'faces', 'subtitle', 'resting'];
