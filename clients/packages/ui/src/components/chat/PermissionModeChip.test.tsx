/**
 * The account's permission mode sits beside the chat input (#360): one chip
 * naming the mode, opening a menu of the four. Auto is shown as coming soon and
 * cannot be picked.
 */
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionModeChip } from './PermissionModeChip';

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

const chip = () => container.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement;
const items = () => Array.from(document.querySelectorAll('[role="menuitemradio"]')) as HTMLElement[];
const item = (label: string) => items().find((el) => el.textContent?.includes(label))!;

describe('the permission mode chip', () => {
  it('names the mode in use', () => {
    act(() => root.render(<PermissionModeChip mode="read_only" onChange={vi.fn()} />));
    expect(chip().textContent).toContain('Read only');
  });

  it('opens a menu of the four modes, with Auto coming soon and not pickable', () => {
    const onOpen = vi.fn();
    act(() => root.render(<PermissionModeChip mode="ask" onChange={vi.fn()} onOpen={onOpen} />));
    act(() => chip().click());
    expect(onOpen).toHaveBeenCalled();
    expect(items().map((el) => el.querySelector('[data-mode-title]')?.textContent)).toEqual([
      'Always ask', 'Read only', 'Full access', 'Auto',
    ]);
    expect(item('Always ask').getAttribute('aria-checked')).toBe('true');
    expect(item('Auto').textContent).toContain('Coming soon');
    expect(item('Auto').getAttribute('aria-disabled')).toBe('true');
  });

  it('picks a mode', () => {
    const onChange = vi.fn();
    act(() => root.render(<PermissionModeChip mode="ask" onChange={onChange} />));
    act(() => chip().click());
    act(() => item('Full access').click());
    expect(onChange).toHaveBeenCalledWith('full');
  });

  it('does not pick Auto', () => {
    const onChange = vi.fn();
    act(() => root.render(<PermissionModeChip mode="ask" onChange={onChange} />));
    act(() => chip().click());
    act(() => item('Auto').click());
    expect(onChange).not.toHaveBeenCalled();
  });
});
