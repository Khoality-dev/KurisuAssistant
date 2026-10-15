/**
 * The composer must not drop a draft when its scope merely resolves.
 *
 * After login the latest conversation id arrives asynchronously. A draft typed
 * before it lands used to be wiped by the scope-reset effect, which is how the
 * Windows e2e runner ended up with an empty composer and a disabled Send right
 * after `fill()` (#145). Leaving a concrete conversation for another one still
 * clears it. The persona in use is the account's and does not change the
 * conversation (#354), so switching it is not a change of scope: the draft is
 * keyed on the conversation alone. `personaId` is still passed below, as the
 * chat used to pass it, to show it no longer matters.
 */

import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatComposer, ChatComposerProps } from './ChatComposer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const baseProps: ChatComposerProps = {
  conversationId: null,
  externalDraft: '',
  externalDraftVersion: 0,
  isStreaming: false,
  onSend: async () => {},
  onCancel: () => {},
};

let container: HTMLDivElement;
let root: Root;

/** `personaId` is not a prop any more; passing it shows switching persona is not a scope change. */
function render(props: Partial<ChatComposerProps> & { personaId?: number | null }) {
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

  it('clears it when leaving a conversation with no persona in use too', () => {
    render({ personaId: null, conversationId: 12 });
    type('a draft the assistant was going to answer');

    render({ personaId: null, conversationId: 13 });

    expect(textarea().value).toBe('');
  });

  it('keeps the draft when the persona in use is switched: the conversation is the same (#354)', () => {
    render({ personaId: 1, conversationId: 12 });
    type('half a sentence');

    render({ personaId: 2, conversationId: 12 });
    expect(textarea().value).toBe('half a sentence');

    render({ personaId: null, conversationId: 12 });
    expect(textarea().value).toBe('half a sentence');
    expect(sendButton().disabled).toBe(false);
  });
});
