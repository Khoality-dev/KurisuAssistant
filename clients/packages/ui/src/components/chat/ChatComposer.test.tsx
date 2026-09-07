/**
 * The composer must not drop a draft when its scope merely resolves.
 *
 * After login the persona id and the latest conversation id both arrive
 * asynchronously. A draft typed before they land used to be wiped by the
 * scope-reset effect, which is how the Windows e2e runner ended up with an
 * empty composer and a disabled Send right after `fill()` (#145). Leaving a
 * concrete conversation for another one still clears it.
 */

import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatComposer, ChatComposerProps } from './ChatComposer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const baseProps: ChatComposerProps = {
  personaId: null,
  conversationId: null,
  externalDraft: '',
  externalDraftVersion: 0,
  isStreaming: false,
  onSend: async () => {},
  onCancel: () => {},
};

let container: HTMLDivElement;
let root: Root;

function render(props: Partial<ChatComposerProps>) {
  act(() => {
    root.render(<ChatComposer {...baseProps} {...props} />);
  });
}

function textarea(): HTMLTextAreaElement {
  const el = container.querySelector('textarea[placeholder="Type your message..."]');
  if (!el) throw new Error('composer textarea not rendered');
  return el as HTMLTextAreaElement;
}

/** Type into the controlled textarea the way a user (or Playwright's fill) does. */
function type(text: string) {
  const el = textarea();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function sendButton(): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll('button'));
  const send = buttons.find((b) => b.textContent?.trim() === 'Send');
  if (!send) throw new Error('Send button not rendered');
  return send;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ChatComposer scope reset', () => {
  it('keeps a draft typed before the persona resolves', () => {
    render({ personaId: null, conversationId: null });
    type('hello while the persona loads');
    expect(sendButton().disabled).toBe(false);

    render({ personaId: 1, conversationId: null });

    expect(textarea().value).toBe('hello while the persona loads');
    expect(sendButton().disabled).toBe(false);
  });

  it('keeps a draft when the latest conversation loads into a new chat', () => {
    render({ personaId: 1, conversationId: null });
    type('typed before the conversation list settled');

    render({ personaId: 1, conversationId: 12 });

    expect(textarea().value).toBe('typed before the conversation list settled');
  });

  it('still clears the draft when leaving one conversation for another', () => {
    render({ personaId: 1, conversationId: 12 });
    type('a draft for conversation 12');
    expect(textarea().value).toBe('a draft for conversation 12');

    render({ personaId: 1, conversationId: 13 });

    expect(textarea().value).toBe('');
    expect(sendButton().disabled).toBe(true);
  });
});
