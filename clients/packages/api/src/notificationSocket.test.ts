/**
 * The device's line to its notifications (#353).
 *
 * The server keeps every notification and whether it has been read; this
 * socket only tells the device what changed. `/ws/notifications` is held for as
 * long as notifications are on for this device and someone is signed in — the
 * window can be hidden in the tray and it keeps listening. On connect the
 * server sends what is unread; then each new notification, and each read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WIRE_PROTOCOL, WS_AUTH_SUBPROTOCOL, WS_WIRE_PROTOCOL_MISMATCH } from '@kurisu/models';
import { NotificationSocket } from './notificationSocket';

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  closed: { code?: number } | null = null;

  constructor(public url: string, public protocols: string[]) {
    FakeSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  serverClose(code: number, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  close(code?: number) {
    this.closed = { code };
    this.readyState = 3;
  }

  send() {}
}

const notification = (id: number, extra: Record<string, unknown> = {}) => ({
  type: 'notification',
  id,
  source: 'assistant',
  sender: 'Kurisu',
  title: `n${id}`,
  body: '',
  conversation_id: null,
  reminder_id: null,
  created_at: '2026-10-16T08:02:00Z',
  read_at: null,
  ...extra,
});

const last = () => FakeSocket.instances[FakeSocket.instances.length - 1];

describe('NotificationSocket', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function make() {
    const seen: Array<[string, unknown]> = [];
    const socket = new NotificationSocket({
      baseUrl: () => 'https://kurisu.example:8443',
      refreshToken: vi.fn(async () => 'fresh-token'),
    });
    socket.subscribe({
      onSync: (unread) => seen.push(['sync', unread.map((n) => n.id)]),
      onNotification: (n) => seen.push(['new', n.id]),
      onRead: (ids) => seen.push(['read', ids]),
    });
    return { socket, seen };
  }

  it('connects only while it is on and someone is signed in', () => {
    const { socket } = make();
    socket.setToken('t1');
    expect(FakeSocket.instances).toHaveLength(0);

    socket.setEnabled(true);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(last().url).toBe('wss://kurisu.example:8443/ws/notifications');
    expect(last().protocols).toEqual([WS_AUTH_SUBPROTOCOL, 't1', `kurisu.wire.${WIRE_PROTOCOL}`]);
  });

  it('hands over what is unread on connect, then each new one and each read', () => {
    const { socket, seen } = make();
    socket.setEnabled(true);
    socket.setToken('t1');
    last().open();

    last().emit({ type: 'notifications_ready', unread: [notification(4), notification(5)] });
    last().emit(notification(6));
    last().emit({ type: 'notifications_read', ids: [4, 6], read_at: '2026-10-16T09:00:00Z' });
    last().emit({ type: 'something_new' });

    expect(seen).toEqual([
      ['sync', [4, 5]],
      ['new', 6],
      ['read', [4, 6]],
    ]);
  });

  it('closes and stays closed when it is turned off', () => {
    const { socket } = make();
    socket.setEnabled(true);
    socket.setToken('t1');
    const first = last();
    first.open();

    socket.setEnabled(false);
    expect(first.closed).not.toBeNull();
    first.serverClose(1000);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('closes when the session ends', () => {
    const { socket } = make();
    socket.setEnabled(true);
    socket.setToken('t1');
    last().open();
    socket.clearToken();
    expect(last().closed).not.toBeNull();
  });

  it('comes back after a dropped connection', () => {
    const { socket } = make();
    socket.setEnabled(true);
    socket.setToken('t1');
    last().open();

    last().serverClose(1006);
    vi.advanceTimersByTime(30_000);

    expect(FakeSocket.instances).toHaveLength(2);
    expect(last().url).toBe('wss://kurisu.example:8443/ws/notifications');
  });

  it('refreshes a refused token rather than retrying it', async () => {
    const { socket } = make();
    socket.setEnabled(true);
    socket.setToken('stale');
    last().serverClose(4001, 'Unauthorized');
    await vi.runAllTimersAsync();
    socket.setToken('fresh-token');
    expect(last().protocols[1]).toBe('fresh-token');
  });

  it('gives up on a server that speaks another protocol', () => {
    const { socket } = make();
    socket.setEnabled(true);
    socket.setToken('t1');
    last().serverClose(WS_WIRE_PROTOCOL_MISMATCH, 'wire_protocol_mismatch');
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
