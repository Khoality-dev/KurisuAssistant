/**
 * Settings → Notifications (#353): one switch for this device, what can notify,
 * and what is unread — the server's list, shown here, read from here.
 */
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notificationSocket, storage } from '@kurisu/api';
import { useNotificationStore } from '@kurisu/state';
import { NotificationsSection } from './NotificationsSection';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const openNotification = vi.fn();
const markAllRead = vi.fn();

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(notificationSocket, 'setEnabled').mockImplementation(() => {});
  openNotification.mockClear();
  markAllRead.mockClear();
  useNotificationStore.setState({ enabled: true, unread: [], openNotification, markAllRead });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const theSwitch = () => container.querySelector('input[type="checkbox"]') as HTMLInputElement;

describe('Settings → Notifications', () => {
  it('shows one switch for this computer, on, and what can notify', () => {
    act(() => root.render(<NotificationsSection />));
    expect(container.textContent).toContain('Notifications on this computer');
    expect(container.textContent).toContain('Notification sources');
    expect(container.textContent).toContain('The assistant');
    expect(container.textContent).toContain('Calendar reminders');
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    expect(theSwitch().checked).toBe(true);
  });

  it('turned off, says this computer will not be notified, and remembers', () => {
    act(() => root.render(<NotificationsSection />));
    act(() => theSwitch().click());
    expect(theSwitch().checked).toBe(false);
    expect(storage.getNotificationsEnabled()).toBe(false);
    expect(container.textContent).not.toContain('Notification sources');
    expect(container.textContent).toContain("This computer won't get");
  });

  it('has no unread list — that is the bell\'s', () => {
    act(() => root.render(<NotificationsSection />));
    expect(container.textContent).not.toContain('Unread');
    expect(container.textContent).not.toContain('Mark all read');
  });
});
