/**
 * Notifications on this device (#353).
 *
 * The server keeps every notification and whether it has been read; this
 * device only displays them. Its own state is two things: the on/off switch,
 * and which notifications it has already shown, so a reconnect shows each one
 * once and takes down the ones read elsewhere meanwhile. Reading — a click on
 * the system notification, opening it from the app's list, reading them all,
 * or opening the conversation it points to — is the server's to record.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBridge, resetBridge } from '@kurisu/platform/testing';
import { apiClient, notificationSocket, storage, type NotificationSocketListener } from '@kurisu/api';
import type { NotificationEvent, NotificationTarget } from '@kurisu/models';
import { useCalendarStore } from './calendarStore';
import { useConversationStore } from './conversationStore';
import { useLayoutStore } from './layoutStore';
import { startNotifications, useNotificationStore } from './notificationStore';

const event = (id: number, extra: Partial<NotificationEvent> = {}): NotificationEvent => ({
  type: 'notification',
  id,
  source: 'assistant',
  sender: 'Kurisu',
  title: `Title ${id}`,
  body: `Body ${id}`,
  conversation_id: null,
  reminder_id: null,
  created_at: '2026-10-16T08:02:00Z',
  read_at: null,
  ...extra,
});

let listener: NotificationSocketListener = {};
let serverUnread: NotificationEvent[] = [];
let open: (click: { target: NotificationTarget; id: number | null }) => void = () => {};
const show = vi.fn(async (_notification: unknown) => true);
const close = vi.fn(async (_ids: number[]) => {});
let stop: () => void = () => {};

beforeEach(() => {
  localStorage.clear();
  show.mockClear();
  close.mockClear();
  vi.spyOn(notificationSocket, 'setEnabled').mockImplementation(() => {});
  vi.spyOn(notificationSocket, 'subscribe').mockImplementation((l) => {
    listener = l;
    return () => {};
  });
  vi.spyOn(apiClient, 'markNotificationRead').mockResolvedValue(undefined as never);
  vi.spyOn(apiClient, 'markAllNotificationsRead').mockResolvedValue(undefined as never);
  vi.spyOn(apiClient, 'markNotificationsReadFor').mockResolvedValue(undefined as never);
  serverUnread = [];
  vi.spyOn(apiClient, 'listNotifications').mockImplementation(async () => ({
    notifications: serverUnread,
    unread_count: serverUnread.length + 10,
  }));
  installBridge({
    capabilities: { systemNotifications: true },
    notifications: {
      show,
      close,
      onOpen: (cb) => {
        open = cb;
        return () => {};
      },
    },
  });
  useNotificationStore.setState({ enabled: storage.getNotificationsEnabled(), unread: [], unreadCount: 0 });
});

afterEach(() => {
  stop();
  resetBridge();
  vi.restoreAllMocks();
});

const unreadIds = () => useNotificationStore.getState().unread.map((n) => n.id);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the switch for this device', () => {
  it('is on until the user turns it off, and the device remembers', () => {
    expect(useNotificationStore.getState().enabled).toBe(true);

    useNotificationStore.getState().setEnabled(false);
    expect(storage.getNotificationsEnabled()).toBe(false);
    expect(notificationSocket.setEnabled).toHaveBeenLastCalledWith(false);

    useNotificationStore.getState().setEnabled(true);
    expect(storage.getNotificationsEnabled()).toBe(true);
    expect(notificationSocket.setEnabled).toHaveBeenLastCalledWith(true);
  });

  it('listens only where the host can show notifications', () => {
    resetBridge();
    installBridge({ capabilities: { systemNotifications: false }, notifications: null });
    stop = startNotifications();
    expect(notificationSocket.setEnabled).toHaveBeenLastCalledWith(false);
  });
});

describe('showing what the server says is unread', () => {
  it('shows each unread one once, saying who it is from', () => {
    stop = startNotifications();
    listener.onSync?.([event(1, { conversation_id: 7 }), event(2)]);
    expect(show).toHaveBeenCalledTimes(2);
    expect(show).toHaveBeenCalledWith({
      id: 1,
      title: 'Kurisu · Title 1',
      body: 'Body 1',
      target: { kind: 'conversation', conversationId: 7 },
    });
    // The same unread again — a reconnect — shows nothing twice.
    listener.onSync?.([event(1), event(2)]);
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('on reconnect, takes down what was read elsewhere and shows what is new', () => {
    stop = startNotifications();
    listener.onSync?.([event(1), event(2)]);
    show.mockClear();

    listener.onSync?.([event(2), event(3)]);
    expect(close).toHaveBeenCalledWith([1]);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][0]).toMatchObject({ id: 3 });
  });

  it('remembers what it showed across a restart of the window', () => {
    stop = startNotifications();
    listener.onSync?.([event(1)]);
    stop();
    show.mockClear();

    stop = startNotifications();
    listener.onSync?.([event(1)]);
    expect(show).not.toHaveBeenCalled();
  });

  it('a new one is shown', () => {
    stop = startNotifications();
    listener.onSync?.([]);
    listener.onNotification?.(event(9));
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('read on any device, it is taken down here', () => {
    stop = startNotifications();
    listener.onSync?.([event(1), event(2)]);
    listener.onRead?.([1]);
    expect(close).toHaveBeenCalledWith([1]);
  });
});

describe('the unread list and its count are the server\'s', () => {
  it('are fetched when listening starts', async () => {
    serverUnread = [event(2), event(1)];
    stop = startNotifications();
    await settle();
    expect(apiClient.listNotifications).toHaveBeenCalledWith({ unread: true, limit: 50 });
    expect(unreadIds()).toEqual([2, 1]);
    expect(useNotificationStore.getState().unreadCount).toBe(12);
  });

  it('are fetched again whenever something arrives or is read', async () => {
    stop = startNotifications();
    await settle();
    vi.mocked(apiClient.listNotifications).mockClear();

    serverUnread = [event(9)];
    listener.onNotification?.(event(9));
    await settle();
    expect(unreadIds()).toEqual([9]);

    serverUnread = [];
    listener.onRead?.([9]);
    await settle();
    expect(unreadIds()).toEqual([]);
    expect(useNotificationStore.getState().unreadCount).toBe(10);
    expect(apiClient.listNotifications).toHaveBeenCalledTimes(2);
  });

  it('can be fetched on demand, socket or not', async () => {
    serverUnread = [event(4)];
    await useNotificationStore.getState().refreshUnread();
    expect(unreadIds()).toEqual([4]);
  });
});

describe('reading', () => {
  it('a click reads it on the server and opens its conversation', () => {
    const loadConversation = vi.fn(async () => {});
    useConversationStore.setState({ loadConversation });
    stop = startNotifications();
    listener.onSync?.([event(1, { conversation_id: 7 })]);

    open({ target: { kind: 'conversation', conversationId: 7 }, id: 1 });
    expect(apiClient.markNotificationRead).toHaveBeenCalledWith(1);
    expect(loadConversation).toHaveBeenCalledWith(7);
  });

  it('a click on a reminder reads it and opens the Calendar on it (#282)', () => {
    vi.spyOn(apiClient, 'getCalendarEntry').mockResolvedValue(undefined as never);
    stop = startNotifications();
    open({ target: { kind: 'calendar', reminderId: 42 }, id: 3 });
    expect(apiClient.markNotificationRead).toHaveBeenCalledWith(3);
    expect(useLayoutStore.getState().activePage).toBe('calendar');
    expect(useCalendarStore.getState().selectedId).toBe(42);
  });

  it('a calendar notification naming no reminder opens the Calendar', () => {
    useLayoutStore.getState().setActivePage('workspace');
    stop = startNotifications();
    open({ target: { kind: 'calendar', reminderId: null }, id: 4 });
    expect(useLayoutStore.getState().activePage).toBe('calendar');
  });

  it('opening the conversation it points to reads it', async () => {
    serverUnread = [event(1, { conversation_id: 7 }), event(2, { conversation_id: 8 })];
    stop = startNotifications();
    await settle();

    useConversationStore.setState({ currentConversation: { id: 7 } as never });
    expect(apiClient.markNotificationsReadFor).toHaveBeenCalledWith({ conversation_id: 7 });

    // A conversation nothing points to costs no request.
    vi.mocked(apiClient.markNotificationsReadFor).mockClear();
    useConversationStore.setState({ currentConversation: { id: 99 } as never });
    expect(apiClient.markNotificationsReadFor).not.toHaveBeenCalled();
  });

  it('reading them all is one request', () => {
    stop = startNotifications();
    useNotificationStore.getState().markAllRead();
    expect(apiClient.markAllNotificationsRead).toHaveBeenCalledTimes(1);
  });
});
