/**
 * The live character feed, in one place any surface can read (#238).
 *
 * Everything a character reacts to used to leave the process from inside the
 * chat widget over IPC, and nothing else in the same window could draw a
 * character. Now the producers write here — the TTS queue, the streaming hook,
 * the vision store, the persona panel — and a surface reads here: the second
 * window (which fills its own copy of this module from IPC), the inline panel
 * (#241), the page an Android WebView hosts.
 *
 * Two halves, because the rates differ. The **refs** are sampled once per
 * animation frame by a surface's loop and never go through zustand's `set`:
 * a `set` per frame would re-render every subscriber. The **store** is what
 * changes at human speed — which personas are in the conversation, who is
 * speaking, whether a surface is showing.
 *
 * Events are how the producers reach the IPC mirror (`useCharacterBridgeSync`)
 * and the subtitle queue without those knowing the producers: every write to
 * the refs also emits, and a subtitle is only an event, since the queue that
 * shows it is the one that knows what "current subtitle" means.
 */
import { create } from 'zustand';
import {
  characterFingerprint,
  type EmotionCue,
  type ParsedCharacterConfig,
  type SpeechSegment,
  type SpeechSync,
  type VrmEmotion,
} from '@kurisu/models';

// ─── The refs ───

/** One burst of gestures. `seq` rises with every push; a surface remembers the last it took. */
export interface GestureBurst {
  names: string[];
  seq: number;
}

export const characterFeed = {
  /** The sentence playing now, or null between turns. */
  speech: { current: null as SpeechSegment | null },
  /** The producer's last reported playback position for that sentence. */
  speechSync: { current: null as SpeechSync | null },
  thinking: { current: false },
  gestures: { current: { names: [], seq: 0 } as GestureBurst },
  faces: { current: [] as string[] },
  /** The cue the no-speech path applies on text arrival (#244); nothing writes it yet. */
  emotionText: { current: null as EmotionCue | null },
};

export interface SubtitleEvent {
  text: string;
  isUser: boolean;
  /** Seconds of audio the text spans; the queue spreads sentences across it. */
  duration?: number;
}

export type CharacterFeedEvent =
  | { type: 'speech'; segment: SpeechSegment | null }
  | { type: 'speech-sync'; sync: SpeechSync }
  | { type: 'thinking'; isThinking: boolean }
  | { type: 'gestures'; names: string[]; seq: number }
  | { type: 'faces'; names: string[] }
  | { type: 'subtitle'; subtitle: SubtitleEvent };

type FeedListener = (event: CharacterFeedEvent) => void;
const listeners = new Set<FeedListener>();

/** Hear every write to the feed. Returns the unsubscribe. */
export function onCharacterFeed(listener: FeedListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function emit(event: CharacterFeedEvent): void {
  for (const listener of listeners) listener(event);
}

/** A sentence began (its curve and start time), or speech ended (`null`). */
export function publishSpeech(segment: SpeechSegment | null): void {
  characterFeed.speech.current = segment;
  characterFeed.speechSync.current = null;
  emit({ type: 'speech', segment });
}

/** The producer's playback position, a few times a second while a sentence plays. */
export function publishSpeechSync(sync: SpeechSync): void {
  if (!characterFeed.speech.current) return;
  characterFeed.speechSync.current = sync;
  emit({ type: 'speech-sync', sync });
}

export function setThinking(isThinking: boolean): void {
  if (characterFeed.thinking.current === isThinking) return;
  characterFeed.thinking.current = isThinking;
  emit({ type: 'thinking', isThinking });
}

/**
 * Gestures are one-shot. Each push is a new burst with a higher `seq`; a
 * surface takes a burst once by remembering the seq it consumed, so two
 * surfaces (or two personas in one window) cannot steal each other's.
 */
export function pushGestures(names: string[]): void {
  if (names.length === 0) return;
  const seq = characterFeed.gestures.current.seq + 1;
  characterFeed.gestures.current = { names, seq };
  emit({ type: 'gestures', names, seq });
}

/** The burst since `lastSeq`, or nothing. */
export function takeGestures(lastSeq: number): GestureBurst {
  const burst = characterFeed.gestures.current;
  return burst.seq > lastSeq ? burst : { names: [], seq: lastSeq };
}

/** Faces are level state: whoever is in view now. */
export function setFaces(names: string[]): void {
  characterFeed.faces.current = names;
  emit({ type: 'faces', names });
}

export function publishSubtitle(subtitle: SubtitleEvent): void {
  emit({ type: 'subtitle', subtitle });
}

/** Everything back to silence — a sign-out, a conversation switch. */
export function resetCharacterFeed(): void {
  publishSpeech(null);
  setThinking(false);
  characterFeed.gestures.current = { names: [], seq: characterFeed.gestures.current.seq };
  setFaces([]);
  characterFeed.emotionText.current = null;
}

// ─── The store ───

export interface CharacterPersona {
  name: string;
  avatarUuid: string | null;
  character: ParsedCharacterConfig | null;
}

interface CharacterState {
  /** Every persona seen in the conversation, by id. */
  personas: Map<number, CharacterPersona>;
  /** Who is speaking (or just spoke); null once the queue has drained. */
  activePersonaId: number | null;
  /** The inline panel is drawing (#241): shown, and not popped out into the window. */
  inlineVisible: boolean;
  /** The separate window is open, so the feed is mirrored over IPC. */
  windowOpen: boolean;
  /** The face to rest on between cues (#244). */
  restingEmotion: VrmEmotion | null;

  /**
   * Keeps the existing entry when nothing a driver would reload has changed:
   * the persona name, the avatar and the character's fingerprint.
   */
  setPersona: (id: number, entry: CharacterPersona) => void;
  removePersona: (id: number) => void;
  clearPersonas: () => void;
  setActivePersonaId: (id: number | null) => void;
  setInlineVisible: (visible: boolean) => void;
  setWindowOpen: (open: boolean) => void;
  setRestingEmotion: (emotion: VrmEmotion | null) => void;
}

function samePersona(a: CharacterPersona, b: CharacterPersona): boolean {
  return a.name === b.name
    && a.avatarUuid === b.avatarUuid
    && characterFingerprint(a.character) === characterFingerprint(b.character);
}

export const useCharacterStore = create<CharacterState>((set) => ({
  personas: new Map(),
  activePersonaId: null,
  inlineVisible: false,
  windowOpen: false,
  restingEmotion: null,

  setPersona: (id, entry) => set((state) => {
    const existing = state.personas.get(id);
    if (existing && samePersona(existing, entry)) return state;
    const personas = new Map(state.personas);
    personas.set(id, entry);
    return { personas };
  }),
  removePersona: (id) => set((state) => {
    if (!state.personas.has(id)) return state;
    const personas = new Map(state.personas);
    personas.delete(id);
    return { personas };
  }),
  clearPersonas: () => set((state) => (state.personas.size === 0 ? state : { personas: new Map() })),
  setActivePersonaId: (activePersonaId) => set((state) => (state.activePersonaId === activePersonaId ? state : { activePersonaId })),
  setInlineVisible: (inlineVisible) => set({ inlineVisible }),
  setWindowOpen: (windowOpen) => set({ windowOpen }),
  setRestingEmotion: (restingEmotion) => set({ restingEmotion }),
}));

/** A surface is showing somewhere, so the personas are worth fetching. */
export function characterSurfaceWanted(state: Pick<CharacterState, 'inlineVisible' | 'windowOpen'>): boolean {
  return state.inlineVisible || state.windowOpen;
}
