/**
 * The OS notifications the renderer asks for (#353).
 *
 * The server keeps every notification and whether it has been read; this only
 * shows them. The renderer holds the notification socket — the window hides to
 * the tray rather than closing, so it keeps running — and hands each one here
 * by the server's id. A click brings the window back and tells the renderer
 * which one, which reads it; a notification read on another device is taken
 * down here by the same id.
 *
 * Under the e2e suite (`KURISU_E2E`) what was shown and taken down is also
 * recorded on `globalThis.__kurisuNotifications`, with a `click(i)` that does
 * what the user's click would: an OS notification is not something a test can
 * see.
 */
import { BrowserWindow, Notification, ipcMain } from 'electron';

interface NotificationRequest {
  id: number;
  title: string;
  body: string;
  target: unknown;
}

export function registerNotificationIPC(focusMainWindow: () => BrowserWindow | null): void {
  // A shown notification is referenced until it is clicked or taken down: one
  // only the OS holds can be collected before it is clicked, and the click is
  // then lost.
  const live = new Map<number, Notification>();
  const shown: NotificationRequest[] = [];
  const closed: number[] = [];

  const open = (request: NotificationRequest | undefined) => {
    if (!request) return;
    live.delete(request.id);
    const window = focusMainWindow();
    window?.webContents.send('notifications:open', { target: request.target, id: request.id });
  };

  if (process.env.KURISU_E2E) {
    (globalThis as any).__kurisuNotifications = {
      shown,
      closed,
      click: (index: number) => open(shown[index]),
    };
  }

  ipcMain.handle('notifications:show', (_event, request: NotificationRequest) => {
    const shownRequest: NotificationRequest = {
      id: Number(request?.id),
      title: String(request?.title ?? '').slice(0, 200),
      body: String(request?.body ?? '').slice(0, 1000),
      target: request?.target ?? { kind: 'app' },
    };
    if (process.env.KURISU_E2E) shown.push(shownRequest);
    if (!Notification.isSupported()) return false;

    live.get(shownRequest.id)?.close();
    const notification = new Notification({ title: shownRequest.title, body: shownRequest.body });
    live.set(shownRequest.id, notification);
    notification.on('click', () => open(shownRequest));
    notification.on('close', () => {
      if (live.get(shownRequest.id) === notification) live.delete(shownRequest.id);
    });
    notification.show();
    return true;
  });

  ipcMain.handle('notifications:close', (_event, ids: unknown) => {
    for (const id of Array.isArray(ids) ? ids : []) {
      if (process.env.KURISU_E2E) closed.push(Number(id));
      const notification = live.get(Number(id));
      live.delete(Number(id));
      notification?.close();
    }
  });
}
