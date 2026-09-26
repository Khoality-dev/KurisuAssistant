/**
 * The mirror between the feed store and the character window (#238): what
 * crosses IPC, only while the window is open, and the `ready` handshake in
 * order — session, personas, then what the feed holds now.
 */
import { fakeCharacterWindow } from '@kurisu/platform/testing';
import {
  publishSpeech,
  publishSpeechSync,
  pushEmotion,
  pushGestures,
  publishSubtitle,
  resetCharacterFeed,
  setFaces,
  setThinking,
  useCharacterStore,
} from '@kurisu/state';
import type { SpeechSegment } from '@kurisu/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mirrorCharacterFeed } from './characterBridgeSync';

const segment: SpeechSegment = { text: 'Hi.', startedAt: 1000, durationMs: 500, windowMs: 33, curve: [0, 1], cues: [] };

describe('mirrorCharacterFeed', () => {
  let api: ReturnType<typeof fakeCharacterWindow>;
  let stop: () => void;
  const refresh = vi.fn(async () => undefined);
  const methods = () => api.calls.map((c) => c.method);

  beforeEach(() => {
    resetCharacterFeed();
    useCharacterStore.setState({ personas: new Map(), activePersonaId: null, windowOpen: false, inlineVisible: false });
    api = fakeCharacterWindow();
    refresh.mockClear();
    stop = mirrorCharacterFeed(api, { getToken: () => 'tok', refresh });
    api.calls.length = 0;
  });
  afterEach(() => stop());

  it('mirrors nothing while the window is closed', () => {
    publishSpeech(segment);
    setThinking(true);
    pushGestures(['wave']);
    setFaces(['Khoa']);
    publishSubtitle({ text: 'hello', isUser: true });
    useCharacterStore.getState().setPersona(1, { name: 'K', avatarUuid: null, character: null });
    expect(api.calls).toEqual([]);
  });

  it('mirrors every kind of write while the window is open', () => {
    useCharacterStore.getState().setWindowOpen(true);
    publishSpeech(segment);
    publishSpeechSync({ positionMs: 100, at: 1100 });
    setThinking(true);
    pushGestures(['wave']);
    setFaces(['Khoa']);
    publishSubtitle({ text: 'hello', isUser: false, duration: 2 });
    useCharacterStore.getState().setPersona(1, { name: 'K', avatarUuid: 'u', character: null });
    useCharacterStore.getState().setActivePersonaId(1);
    expect(methods()).toEqual([
      'sendSpeech', 'sendSpeechSync', 'sendFeed', 'sendGestureUpdate', 'sendFaceUpdate', 'sendSubtitle',
      'sendPersonasUpdate', 'sendPersonasUpdate',
    ]);
    expect(api.calls[0].data).toEqual(segment);
    expect(api.calls[3].data).toEqual({ gestures: ['wave'], seq: expect.any(Number) });
    expect(api.calls[7].data).toEqual({
      personas: [{ id: 1, name: 'K', avatarUuid: 'u', character: null }],
      activePersonaId: 1,
    });
  });

  it('mirrors a feeling shown on text arrival, with whose face it is for (#244)', () => {
    useCharacterStore.getState().setWindowOpen(true);
    setThinking(true);
    api.calls.length = 0;
    pushEmotion({ emotion: 'happy', hold_ms: 2000 }, 7, 1000);
    expect(methods()).toEqual(['sendFeed']);
    expect(api.calls[0].data).toEqual({
      isThinking: true,
      emotion: { cue: { emotion: 'happy', hold_ms: 2000 }, personaId: 7, at: 1000 },
    });
  });

  it('a window that opens while a feeling still holds is handed it with the rest of the feed', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1500);
    pushEmotion({ emotion: 'sad', hold_ms: null }, 2, 1000);
    api.fire('onCharacterReady');
    const feed = api.calls.find((c) => c.method === 'sendFeed');
    expect(feed?.data).toEqual({
      isThinking: false,
      emotion: { cue: { emotion: 'sad', hold_ms: null }, personaId: 2, at: 1000 },
    });
    clock.mockRestore();
  });

  it('answers ready with the session, then the personas, then the feed as it stands', () => {
    useCharacterStore.getState().setPersona(2, { name: 'A', avatarUuid: null, character: null });
    setThinking(true);
    setFaces(['Khoa']);
    publishSpeech(segment);
    api.calls.length = 0;
    api.fire('onCharacterReady');
    expect(methods()).toEqual(['sendSession', 'sendPersonasUpdate', 'sendFeed', 'sendFaceUpdate', 'sendSpeech']);
    expect(api.calls[0].data).toEqual({ accessToken: 'tok' });
    expect(api.calls[2].data).toEqual({ isThinking: true });
    // A ready is proof the window exists: the flag follows it.
    expect(useCharacterStore.getState().windowOpen).toBe(true);
  });

  it('a session request refreshes, and falls back to re-sending the held token', async () => {
    api.fire('onSessionRequest');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(methods()).toEqual([]);
    refresh.mockRejectedValueOnce(new Error('no refresh token'));
    api.fire('onSessionRequest');
    await Promise.resolve();
    await Promise.resolve();
    expect(methods()).toEqual(['sendSession']);
    expect(api.calls[0].data).toEqual({ accessToken: 'tok' });
  });

  it('stops mirroring once stopped', () => {
    useCharacterStore.getState().setWindowOpen(true);
    stop();
    setThinking(true);
    expect(api.calls).toEqual([]);
    stop = () => {};
  });
});
