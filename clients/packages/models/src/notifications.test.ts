/**
 * What a notification opens, and what it says it is (#353).
 *
 * Both clients show the same thing: who it is from — the persona in use, the
 * assistant, or the calendar — and the message, and tapping it opens where it
 * came from.
 */
import { describe, expect, it } from 'vitest';
import { notificationHeading, notificationTarget, type NotificationEvent } from './notifications';

const base: NotificationEvent = {
  type: 'notification',
  id: 3,
  source: 'assistant',
  sender: 'Kurisu',
  title: 'Flight prices to Hanoi',
  body: 'A December fare dropped.',
  conversation_id: null,
  reminder_id: null,
  created_at: '2026-10-16T08:02:00Z',
  read_at: null,
};

describe('what tapping a notification opens', () => {
  it('opens the conversation it came from', () => {
    expect(notificationTarget({ ...base, conversation_id: 7 })).toEqual({ kind: 'conversation', conversationId: 7 });
  });

  it('opens the reminder in the calendar', () => {
    expect(notificationTarget({ ...base, source: 'calendar', sender: 'Calendar', reminder_id: 42 })).toEqual({
      kind: 'calendar',
      reminderId: 42,
    });
  });

  it('opens the app when there is nothing more specific', () => {
    expect(notificationTarget(base)).toEqual({ kind: 'app' });
  });
});

describe('what a notification says it is', () => {
  it('names who it is from, then what it is about', () => {
    expect(notificationHeading(base)).toBe('Kurisu · Flight prices to Hanoi');
    expect(notificationHeading({ ...base, source: 'calendar', sender: 'Calendar', title: 'Call Mom' })).toBe(
      'Calendar · Call Mom',
    );
  });

  it('is just the sender when there is no title', () => {
    expect(notificationHeading({ ...base, title: '' })).toBe('Kurisu');
  });
});
