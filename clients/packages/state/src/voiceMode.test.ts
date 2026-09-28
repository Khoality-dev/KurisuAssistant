import { beforeEach, describe, expect, it, vi } from 'vitest';
import { storage } from '@kurisu/api';
import { useMicStore } from './micStore';

/**
 * Voice mode, turned on from the chat header (#253). It is the only time the
 * mic listens — it replaced the "Always listen" setting. On, the mic listens and
 * waits for the wake word; off, it stops. This device remembers which.
 */

const startListening = vi.fn(async () => { useMicStore.setState({ status: 'listening' }); });
const stopListening = vi.fn(async () => { useMicStore.setState({ status: 'idle' }); });

beforeEach(() => {
  localStorage.clear();
  startListening.mockClear();
  stopListening.mockClear();
  useMicStore.setState({
    status: 'idle', voiceMode: false, interactionActive: false,
    startListening, stopListening,
  });
});

describe('voice mode', () => {
  it('listens and waits for the wake word — no interaction yet', () => {
    useMicStore.getState().startVoiceMode();

    const s = useMicStore.getState();
    expect(s.voiceMode).toBe(true);
    expect(s.interactionActive).toBe(false);
    expect(startListening).toHaveBeenCalledTimes(1);
  });

  it('turned off, ends any interaction and stops listening', () => {
    useMicStore.getState().startVoiceMode();
    useMicStore.getState().activateInteraction();
    useMicStore.getState().endVoiceMode();

    const s = useMicStore.getState();
    expect(s.voiceMode).toBe(false);
    expect(s.interactionActive).toBe(false);
    expect(stopListening).toHaveBeenCalledTimes(1);
  });

  it('stays on when an interaction ends, waiting for the wake word again', () => {
    useMicStore.getState().startVoiceMode();
    useMicStore.getState().activateInteraction();
    useMicStore.getState().deactivateInteraction();

    const s = useMicStore.getState();
    expect(s.voiceMode).toBe(true);
    expect(s.interactionActive).toBe(false);
    expect(stopListening).not.toHaveBeenCalled();
  });

  it('comes back on with the app if this device left it on, and not otherwise', () => {
    useMicStore.getState().restoreVoiceMode();
    expect(useMicStore.getState().voiceMode).toBe(false);
    expect(startListening).not.toHaveBeenCalled();

    useMicStore.getState().startVoiceMode();
    expect(storage.getVoiceMode()).toBe(true);
    useMicStore.setState({ voiceMode: false, status: 'idle' });
    startListening.mockClear();

    useMicStore.getState().restoreVoiceMode();
    expect(useMicStore.getState().voiceMode).toBe(true);
    expect(startListening).toHaveBeenCalledTimes(1);

    useMicStore.getState().endVoiceMode();
    expect(storage.getVoiceMode()).toBe(false);
  });
});
