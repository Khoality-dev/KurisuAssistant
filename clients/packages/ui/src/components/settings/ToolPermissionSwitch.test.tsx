/**
 * A tool that is allowed by default (#353) — notify_user — runs without asking
 * until the user denies it. Settings → Tools lists it with a switch: on is no
 * stored policy (the tool's default), off stores a "deny".
 */
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToolPermissionsStore } from '@kurisu/state';
import { ToolPermissionSwitch } from './ToolPermissionSwitch';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const setToolPolicy = vi.fn(async () => {});
const removeToolPolicy = vi.fn(async () => {});

beforeEach(() => {
  setToolPolicy.mockClear();
  removeToolPolicy.mockClear();
  useToolPermissionsStore.setState({ policy: { tools: {} }, setToolPolicy, removeToolPolicy } as never);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const theSwitch = () => container.querySelector('input[type="checkbox"]') as HTMLInputElement;

describe('the switch for a tool allowed by default', () => {
  it('is on with no stored policy, and off stores a deny', () => {
    act(() => root.render(<ToolPermissionSwitch toolName="notify_user" />));
    expect(container.textContent).toContain('Runs without asking');
    expect(theSwitch().checked).toBe(true);
    act(() => theSwitch().click());
    expect(setToolPolicy).toHaveBeenCalledWith('notify_user', 'deny');
  });

  it('is off when denied, and on removes the deny', () => {
    useToolPermissionsStore.setState({ policy: { tools: { notify_user: 'deny' } } } as never);
    act(() => root.render(<ToolPermissionSwitch toolName="notify_user" />));
    expect(theSwitch().checked).toBe(false);
    expect(container.textContent).toContain('Denied');
    act(() => theSwitch().click());
    expect(removeToolPolicy).toHaveBeenCalledWith('notify_user');
  });
});
