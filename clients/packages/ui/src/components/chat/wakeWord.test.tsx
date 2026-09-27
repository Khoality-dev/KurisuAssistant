/**
 * The assistant's wake word, heard on the desktop (#337).
 *
 * Nothing on the desktop listened for it: said with the mic on, it went into
 * the composer as dictation like anything else, while Android started a voice
 * exchange with it. These drive the chat's own transcript handling
 * (`useInteractiveASR`) with transcripts as the mic store delivers them.
 */
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useInteractiveASR } from '@kurisu/hooks';
import { useMicStore } from '@kurisu/state';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let seq = 0;
const handleSendText = vi.fn(async (_text: string) => {});
const pushExternalDraft = vi.fn((_text: string) => {});

function Chat() {
  useInteractiveASR({
    personaId: 1,
    currentConversationId: 7,
    isStreaming: false,
    isQueueActive: false,
    handleSendText,
    pushExternalDraft,
    stopTTSPlayback: () => {},
  });
  return null;
}

/** A transcript, as the mic store hands one over once speech has been transcribed. */
async function hear(text: string) {
  seq += 1;
  await act(async () => { useMicStore.setState({ result: { text, seq } }); });
}

beforeEach(async () => {
  handleSendText.mockClear();
  pushExternalDraft.mockClear();
  useMicStore.setState({ interactionActive: false, pttActive: false, result: null, triggerWord: 'Kurisu' } as any);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<Chat />); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the wake word on the desktop', () => {
  it('starts a voice exchange and sends what was said', async () => {
    await hear('Hey kurisu, what time is it?');

    expect(handleSendText).toHaveBeenCalledWith('Hey kurisu, what time is it?');
    expect(pushExternalDraft).not.toHaveBeenCalled();
    expect(useMicStore.getState().interactionActive).toBe(true);
  });

  it('is not needed again while the exchange is live', async () => {
    await hear('Kurisu, are you there?');
    await hear('And tomorrow?');

    expect(handleSendText).toHaveBeenLastCalledWith('And tomorrow?');
    expect(pushExternalDraft).not.toHaveBeenCalled();
  });

  it('leaves speech without it to the composer, as dictation', async () => {
    await hear('Buy milk on the way home');

    expect(pushExternalDraft).toHaveBeenCalledWith('Buy milk on the way home');
    expect(handleSendText).not.toHaveBeenCalled();
    expect(useMicStore.getState().interactionActive).toBe(false);
  });

  it('does nothing when the assistant has none', async () => {
    useMicStore.setState({ triggerWord: null } as any);
    await hear('Kurisu, what time is it?');

    expect(pushExternalDraft).toHaveBeenCalledWith('Kurisu, what time is it?');
    expect(handleSendText).not.toHaveBeenCalled();
  });
});
