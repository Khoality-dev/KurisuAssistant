import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

/**
 * What voice mode says when the mic cannot listen (#345).
 *
 * A failure to start is not a one-off toast: it is a state the voice bar shows
 * until it is fixed, and the fix differs by cause — no microphone, access
 * refused, or speech recognition that did not load. And while the mic listens,
 * the store says whether someone is talking right now, which the bar shows as
 * "Listening" and which holds the 30-second window open.
 */

vi.mock('@ricky0123/vad-web', () => ({ MicVAD: { new: vi.fn() } }));

import { MicVAD } from '@ricky0123/vad-web';
import { classifyMicFailure, useMicStore } from './micStore';

const vadNew = MicVAD.new as unknown as Mock;

/** The VAD options the store handed over, so a test can play the VAD's part. */
let vadOptions: any = null;
const fakeVad = { destroy: vi.fn(async () => {}), pause: vi.fn(async () => {}), start: vi.fn(async () => {}) };

function domError(name: string): Error {
  const e = new Error(`${name}: denied or missing`);
  e.name = name;
  return e;
}

beforeEach(async () => {
  localStorage.clear();
  vadNew.mockReset();
  vadOptions = null;
  vadNew.mockImplementation(async (opts: any) => { vadOptions = opts; return fakeVad; });
  await useMicStore.getState().stopListening();
  useMicStore.setState({
    status: 'idle', error: null, problem: null, userSpeaking: false,
    voiceMode: false, interactionActive: false,
  });
});

describe('a mic that cannot start', () => {
  it('refused access is "blocked", shown on the bar rather than as a toast', async () => {
    vadNew.mockRejectedValueOnce(domError('NotAllowedError'));
    useMicStore.getState().startVoiceMode();
    await vi.waitFor(() => expect(useMicStore.getState().problem).toBe('mic-blocked'));

    const s = useMicStore.getState();
    expect(s.error).toBeNull();
    expect(s.status).toBe('idle');
    expect(s.voiceMode).toBe(true);
  });

  it.each(['NotFoundError', 'OverconstrainedError', 'NotReadableError'])(
    '%s means there is no microphone to listen with',
    async (name) => {
      vadNew.mockRejectedValueOnce(domError(name));
      await useMicStore.getState().startListening();

      expect(useMicStore.getState().problem).toBe('no-microphone');
    },
  );

  it('anything else is speech recognition that did not load', async () => {
    vadNew.mockRejectedValueOnce(new Error('no available backend found'));
    await useMicStore.getState().startListening();

    expect(useMicStore.getState().problem).toBe('asr-unavailable');
    expect(classifyMicFailure(new TypeError('Failed to fetch dynamically imported module'))).toBe('asr-unavailable');
  });

  it('trying again clears the problem once the mic starts', async () => {
    vadNew.mockRejectedValueOnce(domError('NotFoundError'));
    useMicStore.getState().startVoiceMode();
    await vi.waitFor(() => expect(useMicStore.getState().problem).toBe('no-microphone'));

    await useMicStore.getState().retryListening();

    expect(useMicStore.getState().problem).toBeNull();
    expect(useMicStore.getState().status).toBe('listening');
    expect(vadNew).toHaveBeenCalledTimes(2);
  });

  it('ending voice mode clears it', async () => {
    vadNew.mockRejectedValueOnce(domError('NotAllowedError'));
    useMicStore.getState().startVoiceMode();
    await vi.waitFor(() => expect(useMicStore.getState().problem).toBe('mic-blocked'));

    useMicStore.getState().endVoiceMode();

    expect(useMicStore.getState().problem).toBeNull();
  });
});

describe('someone talking', () => {
  it('is known from the start of speech to its end, or to a misfire', async () => {
    await useMicStore.getState().startListening();

    vadOptions.onSpeechStart();
    expect(useMicStore.getState().userSpeaking).toBe(true);

    vadOptions.onVADMisfire();
    expect(useMicStore.getState().userSpeaking).toBe(false);

    vadOptions.onSpeechStart();
    await vadOptions.onSpeechEnd(new Float32Array(100));
    expect(useMicStore.getState().userSpeaking).toBe(false);
  });

  it('stops when the mic stops', async () => {
    await useMicStore.getState().startListening();
    vadOptions.onSpeechStart();

    await useMicStore.getState().stopListening();

    expect(useMicStore.getState().userSpeaking).toBe(false);
  });
});
