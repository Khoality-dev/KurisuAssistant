/**
 * Notifications on this device (#353).
 *
 * The server keeps every notification and whether it has been read; this
 * device only displays them. What it keeps of its own is the on/off switch
 * (per device: the phone and the desktop each decide for themselves) and which
 * notifications it has already shown, so a reconnect shows each unread one
 * once and takes down the ones read elsewhere meanwhile.
 *
 * While the switch is on and the host can show notifications, the
 * notification socket stays open — the window may be hidden in the tray. The
 * bell's `unread` list and `unreadCount` are the server's (`GET /notifications`),
 * fetched when listening starts, whenever the socket says something arrived or
 * was read, and when the bell is opened. Reading is the server's to
 * record: a click on the system notification, opening one from the app's
 * list, reading them all, or opening the conversation one points to. Every
 * device, this one included, then hears `notifications_read` and takes it down.
 *
 * The calendar (#282) is not a screen yet; opening a reminder leaves a
 * `calendarRequest` here for it to pick up, and the calendar reads what points
 * at a reminder (`markNotificationsReadFor({ reminder_id })`) when it opens one.
 */
import { create } from 'zustand';
import { apiClient, config, notificationSocket, storage } from '@kurisu/api';
import { notificationHeading, notificationTarget, type NotificationEvent, type NotificationTarget } from '@kurisu/models';
import { resolveBridge } from '@kurisu/platform';
import { useConversationStore } from './conversationStore';

export interface CalendarRequest {
  reminderId: number | null;
  /** When it was asked for, so the same reminder opened twice is two requests. */
  at: number;
}

interface NotificationState {
  enabled: boolean;
  /** What the server says is unread, newest first (the newest 50). */
  unread: NotificationEvent[];
  /** How many the server says are unread — the bell's badge. */
  unreadCount: number;
  /** A reminder a notification asked to see, for the calendar to open. */
  calendarRequest: CalendarRequest | null;
  setEnabled: (on: boolean) => void;
  /** Open one — from the app's list, or a click on its system notification — and read it. */
  openNotification: (click: { target: NotificationTarget; id: number | null }) => void;
  markAllRead: () => void;
  /** Ask the server what is unread — the socket need not be open. */
  refreshUnread: () => Promise<void>;
  clearCalendarRequest: () => void;
}

const reportFailure = (what: string) => (e: unknown) => console.error(`[Notifications] Could not ${what}:`, e);

export const useNotificationStore = create<NotificationState>((set) => ({
  enabled: storage.getNotificationsEnabled(),
  unread: [],
  unreadCount: 0,
  calendarRequest: null,

  setEnabled: (on) => {
    storage.setNotificationsEnabled(on);
    set({ enabled: on });
    notificationSocket.setEnabled(on && !!resolveBridge().notifications);
  },

  openNotification: ({ target, id }) => {
    if (id !== null) void apiClient.markNotificationRead(id).catch(reportFailure('mark it read'));
    if (target.kind === 'conversation') {
      void useConversationStore.getState().loadConversation(target.conversationId);
    } else if (target.kind === 'calendar') {
      set({ calendarRequest: { reminderId: target.reminderId, at: Date.now() } });
    }
  },

  markAllRead: () => {
    void apiClient.markAllNotificationsRead().catch(reportFailure('mark them read'));
  },

  refreshUnread: async () => {
    try {
      const { notifications, unread_count } = await apiClient.listNotifications({ unread: true, limit: 50 });
      set({ unread: notifications, unreadCount: unread_count });
    } catch (e) {
      reportFailure('list them')(e);
    }
  },

  clearCalendarRequest: () => set({ calendarRequest: null }),
}));

/**
 * Listen for this device's notifications and show them, for as long as the
 * returned function is not called. Mounted once, for a signed-in session.
 */
export function startNotifications(): () => void {
  const host = resolveBridge().notifications;
  if (!host) {
    // No OS notifications here; the bell still shows the server's list.
    notificationSocket.setEnabled(false);
    void useNotificationStore.getState().refreshUnread();
    return () => {};
  }

  const server = config.apiBaseUrl;
  const shown = new Set(storage.getShownNotifications(server));
  const remember = () => storage.setShownNotifications(server, [...shown].sort((a, b) => a - b));

  const present = (event: NotificationEvent) => {
    if (shown.has(event.id)) return;
    shown.add(event.id);
    void host
      .show({ id: event.id, title: notificationHeading(event), body: event.body, target: notificationTarget(event) })
      .catch(reportFailure('show one'));
  };

  const takeDown = (ids: number[]) => {
    if (ids.length === 0) return;
    void host.close(ids).catch(reportFailure('take one down'));
    for (const id of ids) shown.delete(id);
  };

  const refresh = () => void useNotificationStore.getState().refreshUnread();

  const unsubscribe = notificationSocket.subscribe({
    onSync: (unread) => {
      const still = new Set(unread.map((n) => n.id));
      takeDown([...shown].filter((id) => !still.has(id)));
      unread.forEach(present);
      remember();
      refresh();
    },
    onNotification: (event) => {
      present(event);
      remember();
      refresh();
    },
    onRead: (ids) => {
      takeDown(ids);
      remember();
      refresh();
    },
  });

  const offOpen = host.onOpen((click) => useNotificationStore.getState().openNotification(click));

  // Opening the conversation a notification points to reads it — only asked
  // when one does, so opening any other conversation costs nothing.
  let openedConversation = useConversationStore.getState().currentConversation?.id ?? null;
  const offConversation = useConversationStore.subscribe((state) => {
    const id = state.currentConversation?.id ?? null;
    if (id === openedConversation) return;
    openedConversation = id;
    if (id !== null && useNotificationStore.getState().unread.some((n) => n.conversation_id === id)) {
      void apiClient.markNotificationsReadFor({ conversation_id: id }).catch(reportFailure('mark them read'));
    }
  });

  notificationSocket.setEnabled(useNotificationStore.getState().enabled);
  refresh();

  return () => {
    unsubscribe();
    offOpen();
    offConversation();
    notificationSocket.setEnabled(false);
  };
}
