/**
 * A notification, as the server keeps it and sends it on `/ws/notifications`
 * (#353), and what a client does with one: what it says it is and what tapping
 * it opens. The server keeps every notification and whether it has been read;
 * the clients only display them. Both clients use the same rules, so the phone
 * and the desktop show the same thing.
 */

export type NotificationSource = 'assistant' | 'calendar';

export interface NotificationEvent {
  type: 'notification';
  /** The device's key for its own "already shown" bookkeeping. */
  id: number;
  source: NotificationSource;
  /** What to show it as: the persona in use when it was sent, `Assistant`, or `Calendar`. */
  sender: string;
  title: string;
  body: string;
  conversation_id: number | null;
  reminder_id: number | null;
  created_at: string;
  /** Null until a device reads it; then every device takes it down. */
  read_at: string | null;
}

/** On connect: what is unread (the last week, at most 50, oldest first). */
export interface NotificationsReadyEvent {
  type: 'notifications_ready';
  unread: NotificationEvent[];
}

/** Some were just read, on whichever device: take each down. */
export interface NotificationsReadEvent {
  type: 'notifications_read';
  ids: number[];
  read_at: string;
}

/** Where tapping a notification goes. */
export type NotificationTarget =
  | { kind: 'conversation'; conversationId: number }
  | { kind: 'calendar'; reminderId: number | null }
  | { kind: 'app' };

export function notificationTarget(event: NotificationEvent): NotificationTarget {
  if (event.source === 'calendar') return { kind: 'calendar', reminderId: event.reminder_id };
  if (event.conversation_id !== null) return { kind: 'conversation', conversationId: event.conversation_id };
  return { kind: 'app' };
}

/** Who it is from, then what it is about: `Kurisu · Flight prices to Hanoi`. */
export function notificationHeading(event: NotificationEvent): string {
  return event.title ? `${event.sender} · ${event.title}` : event.sender;
}
