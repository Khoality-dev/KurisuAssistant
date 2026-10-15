/**
 * This device's line to its notifications: `/ws/notifications` (#353).
 *
 * The server keeps every notification and whether it has been read; this socket
 * only tells the device what changed. It is not the chat socket: the chat is
 * last-one-wins — the phone opening it closes the desktop's — so it cannot
 * carry something meant for every device. This one any number of devices hold
 * at once, and it stays open while the window sits hidden in the tray, which is
 * what lets a notification reach a closed app.
 *
 * It is open while two things hold: notifications are on for this device, and
 * someone is signed in. On connect the server sends what is unread
 * (`notifications_ready`); then each new `notification`, and each
 * `notifications_read` from whichever device read some.
 */

import {
  WIRE_PROTOCOL,
  WS_AUTH_SUBPROTOCOL,
  WS_WIRE_PROTOCOL_MISMATCH,
  WS_WIRE_SUBPROTOCOL_PREFIX,
  type NotificationEvent,
} from '@kurisu/models';
import { config } from './config';

export interface NotificationSocketListener {
  /** On every connect: what the server says is unread, oldest first. */
  onSync?: (unread: NotificationEvent[]) => void;
  onNotification?: (event: NotificationEvent) => void;
  /** Read on some device: take these down. */
  onRead?: (ids: number[]) => void;
}

export interface NotificationSocketOptions {
  /** The backend's base URL, read at every connect: the user can change server. */
  baseUrl: () => string;
  /** A refused token: get a new one. The socket reconnects when `setToken` hands it over. */
  refreshToken: () => Promise<unknown>;
}

const AUTH_FAILED = 4001;
const MAX_RECONNECT_DELAY_MS = 30_000;

export class NotificationSocket {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private enabled = false;
  private stopped = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<NotificationSocketListener>();

  constructor(private readonly options: NotificationSocketOptions) {}

  subscribe(listener: NotificationSocketListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Notifications on or off for this device. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.reconcile();
  }

  setToken(token: string): void {
    const changed = token !== this.token;
    this.token = token;
    this.stopped = false;
    if (changed && this.ws) this.close();
    this.reconcile();
  }

  clearToken(): void {
    this.token = null;
    this.reconcile();
  }

  private reconcile(): void {
    if (this.enabled && this.token && !this.stopped) {
      if (!this.ws && !this.timer) this.open();
    } else {
      this.close();
    }
  }

  private open(): void {
    const url = `${this.options.baseUrl().replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')}/ws/notifications`;
    // A renderer cannot set headers on a WebSocket: the token and the wire
    // protocol ride as subprotocol entries, as on the chat socket.
    const ws = new WebSocket(url, [
      WS_AUTH_SUBPROTOCOL,
      this.token!,
      `${WS_WIRE_SUBPROTOCOL_PREFIX}${WIRE_PROTOCOL}`,
    ]);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
    };

    ws.onmessage = (message) => {
      let data: any;
      try {
        data = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (data?.type === 'notifications_ready' && Array.isArray(data.unread)) {
        this.emit((l) => l.onSync?.(data.unread as NotificationEvent[]));
      } else if (data?.type === 'notification' && typeof data.id === 'number') {
        this.emit((l) => l.onNotification?.(data as NotificationEvent));
      } else if (data?.type === 'notifications_read' && Array.isArray(data.ids)) {
        this.emit((l) => l.onRead?.(data.ids as number[]));
      }
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (event.code === WS_WIRE_PROTOCOL_MISMATCH) {
        // The chat socket raises the update screen; retrying here cannot help.
        this.stopped = true;
        return;
      }
      if (event.code === AUTH_FAILED) {
        // The new token arrives through setToken, which reopens.
        this.options.refreshToken().catch(() => {});
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {};
  }

  private emit(call: (listener: NotificationSocketListener) => void): void {
    for (const listener of this.listeners) {
      try {
        call(listener);
      } catch (e) {
        console.error('[Notifications] Listener failed:', e);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.timer || !(this.enabled && this.token)) return;
    const delay = Math.min(1000 * 2 ** this.attempt, MAX_RECONNECT_DELAY_MS);
    this.attempt++;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.reconcile();
    }, delay);
  }

  private close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.attempt = 0;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, 'Client disconnect');
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * The one this window holds. Started and stopped by `@kurisu/state`'s
 * notification store; the token comes from `apiClient` like the chat socket's.
 */
export const notificationSocket = new NotificationSocket({
  baseUrl: () => config.apiBaseUrl,
  refreshToken: async () => {
    // Dynamic import: client.ts imports this module.
    const { apiClient } = await import('./client');
    return apiClient.tryRefresh();
  },
});
