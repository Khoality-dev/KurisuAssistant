/**
 * Streamed uploads and downloads for Kurisu Drive.
 *
 * These run in the main process rather than the renderer for one reason: a drive
 * file can be gigabytes, and the renderer would have to hold the whole thing in
 * memory to send or receive it. Here the bytes go straight between a file on
 * disk and the socket, a chunk at a time, and progress is reported back over
 * IPC — the same shape `extensions:download-progress` and
 * `updater:download-progress` already use.
 *
 * The access token is passed in per call and set as an `Authorization` header.
 * The drive's download route also accepts `?token=` — an `<img src>` cannot set
 * a header — but there is no reason to put a credential in a URL here, where
 * proxies and logs can see it.
 */

import { app, dialog, ipcMain, net } from 'electron';
import fs from 'fs';
import path from 'path';

interface UploadRequest {
  baseUrl: string;
  token: string;
  localPath: string;
  parentId: number | null;
  name: string;
  overwrite?: boolean;
}

interface DownloadRequest {
  baseUrl: string;
  token: string;
  nodeId: number;
  fileName: string;
}

type Progress = { id: string; loaded: number; total: number | null };

/** In-flight transfers, so the tray's Cancel button has something to abort. */
const inFlight = new Map<string, () => void>();

function emitProgress(event: Electron.IpcMainInvokeEvent, progress: Progress): void {
  if (!event.sender.isDestroyed()) {
    event.sender.send('drive:transfer-progress', progress);
  }
}

/**
 * A name the local filesystem will accept, derived from the drive's own.
 *
 * The drive allows names this machine may not — a colon on Windows, say — and a
 * download must not fail at the last step because of it. Nothing here is a
 * security boundary: the destination directory is fixed below and the basename
 * is taken, so a name containing a separator cannot redirect the write.
 */
function safeLocalName(name: string): string {
  // Only the characters Windows actually rejects, plus control characters.
  // Spaces and hyphens stay: "Q3 revenue notes.md" must not arrive as
  // "Q3_revenue_notes.md".
  // eslint-disable-next-line no-control-regex
  const base = path.basename(name).replace(/[<>:"|?*\x00-\x1f]/g, '_');
  return base.trim() || 'download';
}

/** `report.pdf` → `report (2).pdf` when the first one is already there. */
function uniqueDestination(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = path.join(dir, name);
  let n = 1;
  while (fs.existsSync(candidate)) {
    n += 1;
    candidate = path.join(dir, `${stem} (${n})${ext}`);
  }
  return candidate;
}

const MULTIPART_BOUNDARY = '----KurisuDriveBoundary7MA4YWxkTrZu0gW';

/**
 * Multipart, written by hand because the body has to stream.
 *
 * `FormData` in the renderer would buffer the file; here the preamble and the
 * epilogue are small strings and the file itself is piped between them.
 */
function multipartPreamble(req: UploadRequest): Buffer {
  const parts: string[] = [];
  if (req.parentId !== null) {
    parts.push(
      `--${MULTIPART_BOUNDARY}\r\n`,
      'Content-Disposition: form-data; name="parent_id"\r\n\r\n',
      `${req.parentId}\r\n`,
    );
  }
  parts.push(
    `--${MULTIPART_BOUNDARY}\r\n`,
    'Content-Disposition: form-data; name="name"\r\n\r\n',
    `${req.name}\r\n`,
  );
  parts.push(
    `--${MULTIPART_BOUNDARY}\r\n`,
    `Content-Disposition: form-data; name="file"; filename="${req.name.replace(/"/g, '')}"\r\n`,
    'Content-Type: application/octet-stream\r\n\r\n',
  );
  return Buffer.from(parts.join(''), 'utf-8');
}

function multipartEpilogue(): Buffer {
  return Buffer.from(`\r\n--${MULTIPART_BOUNDARY}--\r\n`, 'utf-8');
}

function readBody(response: Electron.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

/** The server's own sentence, which is written for a person, or a fallback. */
function detailFrom(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.detail === 'string' && parsed.detail) return parsed.detail;
  } catch {
    // Not JSON — a proxy's error page, most likely.
  }
  if (status === 413) return 'That file is larger than the server allows.';
  if (status === 507) return 'Your drive is full.';
  return `The server refused the transfer (${status}).`;
}

async function uploadOne(
  event: Electron.IpcMainInvokeEvent,
  id: string,
  req: UploadRequest,
): Promise<{ node?: unknown; error?: string; cancelled?: boolean }> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(req.localPath);
  } catch {
    return { error: 'That file is no longer there.' };
  }
  if (stat.isDirectory()) {
    return { error: 'Folders cannot be uploaded yet — upload the files inside it.' };
  }

  const preamble = multipartPreamble(req);
  const epilogue = multipartEpilogue();
  const total = stat.size;

  return new Promise((resolve) => {
    const url = new URL('/drive/files', req.baseUrl);
    if (req.overwrite) url.searchParams.set('overwrite', 'true');

    const request = net.request({ method: 'POST', url: url.toString() });
    request.setHeader('Authorization', `Bearer ${req.token}`);
    request.setHeader('Content-Type', `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`);

    let settled = false;
    let cancelled = false;
    const finish = (result: { node?: unknown; error?: string; cancelled?: boolean }) => {
      if (settled) return;
      settled = true;
      inFlight.delete(id);
      resolve(result);
    };

    inFlight.set(id, () => {
      cancelled = true;
      try {
        request.abort();
      } catch {
        // Already finished.
      }
    });

    request.on('response', async (response) => {
      const body = await readBody(response);
      if (response.statusCode >= 200 && response.statusCode < 300) {
        try {
          finish({ node: JSON.parse(body) });
        } catch {
          finish({ error: 'The server replied with something unreadable.' });
        }
      } else {
        finish({ error: detailFrom(body, response.statusCode) });
      }
    });

    request.on('error', (error) => {
      finish(cancelled ? { cancelled: true } : { error: error.message });
    });
    request.on('abort', () => finish({ cancelled: true }));

    request.write(preamble);

    let sent = 0;
    const source = fs.createReadStream(req.localPath);
    source.on('data', (chunk: Buffer) => {
      if (cancelled) {
        source.destroy();
        return;
      }
      request.write(chunk);
      sent += chunk.length;
      emitProgress(event, { id, loaded: sent, total });
    });
    source.on('end', () => {
      if (cancelled) return;
      request.write(epilogue);
      request.end();
    });
    source.on('error', (error) => {
      try {
        request.abort();
      } catch {
        // Already gone.
      }
      finish({ error: error.message });
    });
  });
}

async function downloadOne(
  event: Electron.IpcMainInvokeEvent,
  id: string,
  req: DownloadRequest,
): Promise<{ path?: string; error?: string; cancelled?: boolean }> {
  const dir = app.getPath('downloads');
  const destination = uniqueDestination(dir, safeLocalName(req.fileName));
  // Written under a partial name and renamed at the end, so an interrupted
  // download never looks like a complete file.
  const partial = `${destination}.part`;

  return new Promise((resolve) => {
    const url = new URL(`/drive/files/${req.nodeId}/content`, req.baseUrl);
    const request = net.request({ method: 'GET', url: url.toString() });
    request.setHeader('Authorization', `Bearer ${req.token}`);

    let settled = false;
    let cancelled = false;
    let sink: fs.WriteStream | null = null;

    const cleanUp = () => {
      sink?.destroy();
      try {
        fs.rmSync(partial, { force: true });
      } catch {
        // Nothing to remove.
      }
    };

    const finish = (result: { path?: string; error?: string; cancelled?: boolean }) => {
      if (settled) return;
      settled = true;
      inFlight.delete(id);
      if (result.path === undefined) cleanUp();
      resolve(result);
    };

    inFlight.set(id, () => {
      cancelled = true;
      try {
        request.abort();
      } catch {
        // Already finished.
      }
    });

    request.on('response', (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        readBody(response).then((body) =>
          finish({ error: detailFrom(body, response.statusCode) }),
        );
        return;
      }

      const header = response.headers['content-length'];
      const declared = Array.isArray(header) ? header[0] : header;
      const total = declared ? Number(declared) : null;
      let received = 0;

      sink = fs.createWriteStream(partial);
      sink.on('error', (error) => finish({ error: error.message }));

      response.on('data', (chunk: Buffer) => {
        if (cancelled) return;
        sink!.write(chunk);
        received += chunk.length;
        emitProgress(event, { id, loaded: received, total });
      });
      response.on('end', () => {
        if (cancelled) {
          finish({ cancelled: true });
          return;
        }
        sink!.end(() => {
          try {
            fs.renameSync(partial, destination);
            finish({ path: destination });
          } catch (error) {
            finish({ error: (error as Error).message });
          }
        });
      });
      response.on('error', (error: Error) => finish({ error: error.message }));
    });

    request.on('error', (error) => {
      finish(cancelled ? { cancelled: true } : { error: error.message });
    });
    request.on('abort', () => finish({ cancelled: true }));
    request.end();
  });
}

export function registerDriveTransferIPC(): void {
  ipcMain.handle('drive:upload', (event, id: string, req: UploadRequest) =>
    uploadOne(event, id, req),
  );

  ipcMain.handle('drive:download', (event, id: string, req: DownloadRequest) =>
    downloadOne(event, id, req),
  );

  ipcMain.handle('drive:cancel', (_event, id: string) => {
    inFlight.get(id)?.();
    return { cancelled: true };
  });

  ipcMain.handle('drive:pick-files', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Upload to Kurisu Drive',
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return [];
    return result.filePaths.map((filePath) => ({
      path: filePath,
      name: path.basename(filePath),
      size: (() => {
        try {
          return fs.statSync(filePath).size;
        } catch {
          return 0;
        }
      })(),
    }));
  });
}
