/**
 * Each interaction is a new conversation (#253), so the chat opens on a marker
 * that says so (#345): when the wake word was heard, and — when there was a
 * conversation before it — that it is kept in Conversations, one click away.
 */
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewInteractionMarker } from './NewInteractionMarker';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const onOpenConversations = vi.fn();
const at = new Date(2026, 8, 28, 19, 42).getTime();
const time = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (hasPrevious: boolean) => act(() => {
  root.render(<NewInteractionMarker wakeWord="kurisu" at={at} hasPrevious={hasPrevious} onOpenConversations={onOpenConversations} />);
});

describe('the new-conversation marker', () => {
  it('says the conversation is new and when the wake word was heard', () => {
    render(true);

    expect(container.textContent).toContain('New conversation');
    expect(container.textContent).toContain(`You said “Kurisu” at ${time}.`);
  });

  it('points to Conversations, where the previous one is kept', () => {
    render(true);

    expect(container.textContent).toContain('The last one is in Conversations.');
    const link = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Conversations')!;
    act(() => link.click());
    expect(onOpenConversations).toHaveBeenCalledTimes(1);
  });

  it('does not mention a previous conversation when there was none', () => {
    render(false);

    expect(container.textContent).not.toContain('The last one');
  });
});
