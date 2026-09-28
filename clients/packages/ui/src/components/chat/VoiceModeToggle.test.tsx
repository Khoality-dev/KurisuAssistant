/**
 * The chat header's voice mode control (#345). Off, a grey headset icon; on, a
 * solid blue pill that says so — "Voice mode on", or "On" in a narrow column —
 * so it reads from across the room. A dot on it while voice mode has a problem.
 */
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceModeToggle } from './VoiceModeToggle';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const onStart = vi.fn();
const onEnd = vi.fn();

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

function renderToggle(on: boolean, over: { narrow?: boolean; attention?: boolean } = {}) {
  act(() => {
    root.render(
      <VoiceModeToggle on={on} narrow={over.narrow ?? false} attention={over.attention ?? false} onStart={onStart} onEnd={onEnd} />,
    );
  });
}

const theButton = () => container.querySelector('button') as HTMLButtonElement;

describe('voice mode off', () => {
  it('is an icon that starts it, with no words', () => {
    renderToggle(false);

    expect(theButton().getAttribute('aria-label')).toBe('Start voice mode');
    expect(theButton().textContent).toBe('');
    act(() => theButton().click());
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});

describe('voice mode on', () => {
  it('is a pill that says so, and ends it', () => {
    renderToggle(true);

    expect(theButton().textContent).toBe('Voice mode on');
    expect(theButton().getAttribute('aria-label')).toBe('End voice mode');
    act(() => theButton().click());
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('says only "On" in a narrow column', () => {
    renderToggle(true, { narrow: true });

    expect(theButton().textContent).toBe('On');
  });

  it('carries a dot while voice mode has a problem, and not otherwise', () => {
    renderToggle(true);
    expect(container.querySelector('[data-testid="voice-mode-attention"]')).toBeNull();

    renderToggle(true, { attention: true });
    expect(container.querySelector('[data-testid="voice-mode-attention"]')).not.toBeNull();
  });
});
