/**
 * A settings section that throws while rendering keeps to its own pane (#296).
 *
 * Nothing caught a render error anywhere in the client, so one section that
 * threw unmounted the whole tree: a blank window, the navigation and the chat
 * gone with it, and the error itself visible only in a console nobody opens.
 */
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLayoutStore } from '@kurisu/state';

let assistantThrows = true;

vi.mock('./AssistantSection', () => ({
  AssistantSection: () => {
    if (assistantThrows) throw new Error('assistant.tools is undefined');
    return <div>Assistant form</div>;
  },
}));
vi.mock('./PersonasSection', () => ({
  PersonasSection: () => <div>Persona list</div>,
}));

import { SettingsPage } from './SettingsPage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

/** Lazy sections resolve on later ticks; give them a few. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
};

const button = (text: string) =>
  [...container.querySelectorAll('button, [role="button"]')].find((b) => b.textContent?.trim() === text) as HTMLElement | undefined;

beforeEach(() => {
  assistantThrows = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useLayoutStore.setState({ settingsSection: 'assistant' });
  // React reports a caught render error on the console as well; that is the
  // log the boundary is meant to leave, not noise in this test's output.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('a settings section that fails to render', () => {
  it('leaves the navigation on screen and says what failed', async () => {
    await act(async () => { root.render(<SettingsPage />); });
    await settle();

    expect(container.textContent).toContain('Personas');
    expect(container.textContent).toContain('This page could not be shown');
    expect(container.textContent).toContain('assistant.tools is undefined');
  });

  it('logs the error with its stack', async () => {
    await act(async () => { root.render(<SettingsPage />); });
    await settle();

    const logged = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls
      .some((args) => args.some((a) => a instanceof Error && a.message === 'assistant.tools is undefined'));
    expect(logged).toBe(true);
  });

  it('recovers when another section is chosen', async () => {
    await act(async () => { root.render(<SettingsPage />); });
    await settle();

    await act(async () => { button('Personas')!.click(); });
    await settle();

    expect(container.textContent).toContain('Persona list');
    expect(container.textContent).not.toContain('This page could not be shown');
  });

  it('recovers on Try again once the section renders', async () => {
    await act(async () => { root.render(<SettingsPage />); });
    await settle();

    assistantThrows = false;
    await act(async () => { button('Try again')!.click(); });
    await settle();

    expect(container.textContent).toContain('Assistant form');
  });
});
