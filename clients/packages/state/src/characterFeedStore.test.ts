import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedCharacterConfig, PoseTree, SpeechSegment } from '@kurisu/models';
import {
  characterFeed,
  characterSurfaceWanted,
  onCharacterFeed,
  publishSpeech,
  publishSpeechSync,
  pushGestures,
  resetCharacterFeed,
  setFaces,
  setThinking,
  takeGestures,
  useCharacterStore,
  type CharacterFeedEvent,
} from './characterFeedStore';

const segment: SpeechSegment = { text: 'Hi.', startedAt: 1000, durationMs: 500, windowMs: 33, curve: [0, 1], cues: [] };

const tree = (base: string): PoseTree => ({
  default_pose_ids: ['a'],
  nodes: [{
    id: 'a', name: 'a', type: 'pose', position: { x: 0, y: 0 },
    pose_config: { name: 'a', base_image_url: base, left_eye: { patches: [] }, right_eye: { patches: [] }, mouth: { patches: [] } },
  }],
  edges: [],
});
const poseGraph = (base: string): ParsedCharacterConfig => ({ kind: 'pose_graph', poseTree: tree(base), vrm: null });

describe('the character feed', () => {
  let heard: CharacterFeedEvent[];
  let off: () => void;

  beforeEach(() => {
    resetCharacterFeed();
    heard = [];
    off = onCharacterFeed((e) => heard.push(e));
  });
  afterEach(() => off());

  it('a gesture burst is taken once per consumer, by seq', () => {
    const before = characterFeed.gestures.current.seq;
    pushGestures(['wave']);
    const first = takeGestures(before);
    expect(first.names).toEqual(['wave']);
    expect(first.seq).toBe(before + 1);
    // The same consumer asks again: nothing new.
    expect(takeGestures(first.seq).names).toEqual([]);
    // A second consumer that never took it still gets it.
    expect(takeGestures(before).names).toEqual(['wave']);
    // An empty push is not a burst.
    pushGestures([]);
    expect(characterFeed.gestures.current.seq).toBe(first.seq);
    expect(heard.filter((e) => e.type === 'gestures')).toHaveLength(1);
  });

  it('thinking emits on change only', () => {
    setThinking(true);
    setThinking(true);
    setThinking(false);
    expect(heard.filter((e) => e.type === 'thinking').map((e) => (e as { isThinking: boolean }).isThinking)).toEqual([true, false]);
    expect(characterFeed.thinking.current).toBe(false);
  });

  it('a new sentence drops the previous sync, and a sync without a sentence is ignored', () => {
    publishSpeech(segment);
    publishSpeechSync({ positionMs: 100, at: 1100 });
    expect(characterFeed.speechSync.current).toEqual({ positionMs: 100, at: 1100 });
    publishSpeech({ ...segment, startedAt: 2000 });
    expect(characterFeed.speechSync.current).toBeNull();
    publishSpeech(null);
    publishSpeechSync({ positionMs: 10, at: 3000 });
    expect(characterFeed.speechSync.current).toBeNull();
    expect(heard.map((e) => e.type)).toEqual(['speech', 'speech-sync', 'speech', 'speech']);
  });

  it('faces are level state and a subtitle is only an event', () => {
    setFaces(['Khoa']);
    expect(characterFeed.faces.current).toEqual(['Khoa']);
    setFaces([]);
    expect(characterFeed.faces.current).toEqual([]);
  });

  it('a listener that unsubscribes hears nothing more', () => {
    const late = vi.fn();
    const stop = onCharacterFeed(late);
    setThinking(true);
    stop();
    setThinking(false);
    expect(late).toHaveBeenCalledTimes(1);
  });
});

describe('the character store', () => {
  beforeEach(() => {
    useCharacterStore.setState({ personas: new Map(), activePersonaId: null, inlineVisible: false, windowOpen: false });
  });

  it('keeps a persona entry when nothing a driver would reload has changed', () => {
    const { setPersona } = useCharacterStore.getState();
    setPersona(1, { name: 'Kurisu', avatarUuid: null, character: poseGraph('/character-assets/1/a/base') });
    const first = useCharacterStore.getState().personas;
    setPersona(1, { name: 'Kurisu', avatarUuid: null, character: poseGraph('/character-assets/1/a/base') });
    expect(useCharacterStore.getState().personas).toBe(first);
    // The old count comparison could not see this: same shape, a different image.
    setPersona(1, { name: 'Kurisu', avatarUuid: null, character: poseGraph('/character-assets/1/b/base') });
    expect(useCharacterStore.getState().personas).not.toBe(first);
    setPersona(1, { name: 'Amadeus', avatarUuid: null, character: poseGraph('/character-assets/1/b/base') });
    expect(useCharacterStore.getState().personas.get(1)?.name).toBe('Amadeus');
  });

  it('a surface is wanted when either the window or the inline panel shows', () => {
    expect(characterSurfaceWanted({ inlineVisible: false, windowOpen: false })).toBe(false);
    expect(characterSurfaceWanted({ inlineVisible: true, windowOpen: false })).toBe(true);
    expect(characterSurfaceWanted({ inlineVisible: false, windowOpen: true })).toBe(true);
  });

  it('setting the same active persona again does not produce a new state', () => {
    const { setActivePersonaId } = useCharacterStore.getState();
    setActivePersonaId(3);
    const s = useCharacterStore.getState();
    setActivePersonaId(3);
    expect(useCharacterStore.getState()).toBe(s);
  });
});
