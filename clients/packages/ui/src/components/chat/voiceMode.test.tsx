/**
 * What voice mode does with what is said (#337, #253).
 *
 * Voice mode on: the mic waits for the wake word; hearing it starts an
 * interaction, which sends everything said — no wake word again — until 30 s
 * after the assistant's last reply (finished streaming and speaking), when
 * voice mode waits for the wake word again. Each interaction is a new
 * conversation. Voice mode off: the mic does not
 * listen at all. These drive the chat's own transcript handling
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
const handleSendText = vi.fn(async (_text: string, _opts?: { newConversation?: boolean }) => {});
const reply = { isStreaming: false, isQueueActive: false };

function Chat() {
  useInteractiveASR({
    isStreaming: reply.isStreaming,
    isQueueActive: reply.isQueueActive,
    handleSendText,
    stopTTSPlayback: () => {},
  });
  return null;
}

const render = () => act(async () => { root.render(<Chat />); });

/** A transcript, as the mic store hands one over once speech has been transcribed. */
async function hear(text: string) {
  seq += 1;
  await act(async () => { useMicStore.setState({ result: { text, seq } }); });
}

/** The assistant answering: streaming, then speaking, then done. */
async function answer(phase: 'streaming' | 'speaking' | 'done') {
  reply.isStreaming = phase === 'streaming';
  reply.isQueueActive = phase === 'speaking';
  await render();
}

beforeEach(async () => {
  vi.useFakeTimers();
  handleSendText.mockClear();
  reply.isStreaming = false;
  reply.isQueueActive = false;
  useMicStore.setState({
    voiceMode: true, interactionActive: false, result: null, triggerWord: 'Kurisu',
  } as any);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await render();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('in voice mode', () => {
  it('the wake word starts an interaction in a new conversation, and is its first message', async () => {
    await hear('Hey kurisu, what time is it?');

    expect(handleSendText).toHaveBeenCalledWith('Hey kurisu, what time is it?', { newConversation: true });
    expect(useMicStore.getState().interactionActive).toBe(true);
  });

  it('once it has started, everything said is sent to that conversation without the wake word', async () => {
    await hear('Kurisu, are you there?');
    await hear('And tomorrow?');

    expect(handleSendText).toHaveBeenLastCalledWith('And tomorrow?', { newConversation: false });
  });

  it('the next interaction is another new conversation', async () => {
    await hear('Kurisu, first question');
    await act(async () => { useMicStore.getState().deactivateInteraction(); });
    await hear('Kurisu, second question');

    expect(handleSendText).toHaveBeenLastCalledWith('Kurisu, second question', { newConversation: true });
  });

  it('speech without the wake word is not sent — it keeps waiting', async () => {
    await hear('Buy milk on the way home');

    expect(handleSendText).not.toHaveBeenCalled();
    expect(useMicStore.getState().interactionActive).toBe(false);
  });

  it('with no wake word set, nothing starts an interaction', async () => {
    useMicStore.setState({ triggerWord: null } as any);
    await hear('Kurisu, what time is it?');

    expect(handleSendText).not.toHaveBeenCalled();
  });
});

describe('the interaction timeout', () => {
  it('ends the interaction 30 s after the last reply finished, and voice mode waits again', async () => {
    await hear('Kurisu, what time is it?');
    await answer('streaming');
    await answer('speaking');
    await answer('done');

    await act(async () => { vi.advanceTimersByTime(29_000); });
    expect(useMicStore.getState().interactionActive).toBe(true);

    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(useMicStore.getState().interactionActive).toBe(false);
    expect(useMicStore.getState().voiceMode).toBe(true);
  });

  it('does not run while the assistant is still answering or speaking', async () => {
    await hear('Kurisu, tell me a long story');
    await answer('streaming');
    await act(async () => { vi.advanceTimersByTime(60_000); });
    await answer('speaking');
    await act(async () => { vi.advanceTimersByTime(60_000); });

    expect(useMicStore.getState().interactionActive).toBe(true);
  });

  it('starts over when the user speaks again', async () => {
    await hear('Kurisu, hello');
    await act(async () => { vi.advanceTimersByTime(20_000); });
    await hear('Still there?');
    await answer('streaming');
    await answer('done');
    await act(async () => { vi.advanceTimersByTime(20_000); });

    expect(useMicStore.getState().interactionActive).toBe(true);
  });
});

describe('with voice mode off', () => {
  it('nothing said is used — the mic is off, and a late transcript is dropped', async () => {
    useMicStore.setState({ voiceMode: false } as any);
    await hear('Hey kurisu, what time is it?');

    expect(handleSendText).not.toHaveBeenCalled();
    expect(useMicStore.getState().interactionActive).toBe(false);
  });
});
