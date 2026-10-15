/**
 * The bell on the activity bar (#353): the server's unread count as a badge,
 * and the unread list one click away. Opening an item reads it and goes where
 * it points; "Mark all read" reads them all — on every device.
 */
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationEvent } from '@kurisu/models';
import { useNotificationStore } from '@kurisu/state';
import { NotificationBell } from './NotificationBell';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const unread = (id: number, title: string): NotificationEvent => ({
  type: 'notification',
  id,
  source: 'assistant',
  sender: 'Kurisu',
  title,
  body: 'The machine is done.',
  conversation_id: 7,
  reminder_id: null,
  created_at: '2026-10-16T08:02:00Z',
  read_at: null,
});

const openNotification = vi.fn();
const markAllRead = vi.fn();
const refreshUnread = vi.fn(async () => {});

beforeEach(() => {
  openNotification.mockClear();
  markAllRead.mockClear();
  refreshUnread.mockClear();
  useNotificationStore.setState({ unread: [], unreadCount: 0, openNotification, markAllRead, refreshUnread });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

const bell = () => document.querySelector('button[aria-label^="Notifications"]') as HTMLElement;
const button = (text: string) =>
  [...document.querySelectorAll('button, [role="button"], [role="menuitem"]')].find((b) => b.textContent?.includes(text)) as HTMLElement | undefined;

describe('the notifications bell', () => {
  it('shows the server\'s unread count, and nothing when there is none', () => {
    useNotificationStore.setState({ unreadCount: 3 });
    act(() => root.render(<NotificationBell />));
    expect(bell().getAttribute('aria-label')).toBe('Notifications, 3 unread');
    expect(container.textContent).toContain('3');

    act(() => useNotificationStore.setState({ unreadCount: 0 }));
    expect(bell().getAttribute('aria-label')).toBe('Notifications');
  });

  it('opens the unread list, fresh from the server', () => {
    useNotificationStore.setState({ unread: [unread(2, 'Laundry'), unread(1, 'Fares')], unreadCount: 2 });
    act(() => root.render(<NotificationBell />));
    act(() => bell().click());
    expect(refreshUnread).toHaveBeenCalled();
    expect(document.body.textContent).toContain('Kurisu · Laundry');
    expect(document.body.textContent).toContain('Kurisu · Fares');
  });

  it('opening an item reads it and goes where it points', () => {
    useNotificationStore.setState({ unread: [unread(2, 'Laundry')], unreadCount: 1 });
    act(() => root.render(<NotificationBell />));
    act(() => bell().click());
    act(() => button('Kurisu · Laundry')!.click());
    expect(openNotification).toHaveBeenCalledWith({ target: { kind: 'conversation', conversationId: 7 }, id: 2 });
  });

  it('reads them all', () => {
    useNotificationStore.setState({ unread: [unread(2, 'Laundry')], unreadCount: 1 });
    act(() => root.render(<NotificationBell />));
    act(() => bell().click());
    act(() => button('Mark all read')!.click());
    expect(markAllRead).toHaveBeenCalledTimes(1);
  });

  it('says when nothing is unread', () => {
    act(() => root.render(<NotificationBell />));
    act(() => bell().click());
    expect(document.body.textContent).toContain('Nothing unread');
    expect(button('Mark all read')).toBeUndefined();
  });
});
