/**
 * The approval bar asks about one call: approve it or deny it (#360). There is
 * no "allow for this session", "always allow" or "always deny" — how much the
 * assistant may do without asking is the permission mode, not a per-tool rule.
 */
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolApprovalBar } from './ToolApprovalBar';

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

const request = { toolName: 'drive_write', description: 'Write notes/a.md', executionLocation: 'backend' as const };
const choices = () => Array.from(container.querySelectorAll('[role="button"]')) as HTMLElement[];

describe('the approval bar', () => {
  it('offers exactly Approve and Deny', () => {
    act(() => root.render(<ToolApprovalBar request={request} onRespond={vi.fn()} />));
    const labels = choices().map((b) => b.textContent?.trim());
    expect(labels).toEqual(['Approve', 'Deny']);
  });

  it('answers with the choice', () => {
    const onRespond = vi.fn();
    act(() => root.render(<ToolApprovalBar request={request} onRespond={onRespond} />));
    const deny = choices().find((b) => b.textContent?.trim() === 'Deny')!;
    act(() => deny.click());
    expect(onRespond).toHaveBeenCalledWith('deny');
  });
});
