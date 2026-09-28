/**
 * How full the conversation's context is, as a bar in the chat header (#343).
 *
 * It was "1,234 / 8,192 tokens" in the header: exact counts nobody needs
 * mid-chat, hard to read at a glance. The bar shows the share used, warns as it
 * fills — as the numbers did, orange past 80% and red past 90% — and says the
 * percentage on hover. The exact counts stay in the context breakdown.
 */
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextUsageBar } from './ContextUsageBar';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const bar = () => container.querySelector('[role="progressbar"]') as HTMLElement;

describe('the context usage bar', () => {
  it('shows the share of the context used as a bar, with no token numbers', async () => {
    await act(async () => { root.render(<ContextUsageBar tokenCount={2048} contextSize={8192} />); });

    expect(bar()).not.toBeNull();
    expect(bar().getAttribute('aria-valuenow')).toBe('25');
    expect(bar().getAttribute('aria-label')).toBe('Context 25% used');
    expect(container.textContent).not.toMatch(/tokens|2,048|8,192/);
  });

  it('warns past 80% and is full past 90%', async () => {
    await act(async () => { root.render(<ContextUsageBar tokenCount={7000} contextSize={8192} />); });
    expect(bar().closest('[data-level]')?.getAttribute('data-level')).toBe('warning');

    await act(async () => { root.render(<ContextUsageBar tokenCount={7500} contextSize={8192} />); });
    expect(bar().closest('[data-level]')?.getAttribute('data-level')).toBe('full');

    await act(async () => { root.render(<ContextUsageBar tokenCount={100} contextSize={8192} />); });
    expect(bar().closest('[data-level]')?.getAttribute('data-level')).toBe('ok');
  });

  it('never runs past the end when the context overflows', async () => {
    await act(async () => { root.render(<ContextUsageBar tokenCount={9000} contextSize={8192} />); });
    expect(bar().getAttribute('aria-valuenow')).toBe('100');
  });
});
