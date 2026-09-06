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

/**
 * Claim a free destination, atomically.
 *
 * The `.part` file is created with `wx` — fail if it exists — inside the same
 * loop that picks the name. Checking whether the *final* name is free and then
 * writing to `<final>.part` is a race two simultaneous downloads of the same
 * file lose: both see the final name free, both open the same part file, and
 * their bytes interleave into one corrupt result.
 *
 * Returns the final path and an already-open handle on its part file.
 */
function claimDestination(dir: string, name: string): { destination: string; partial: string; handle: number } {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  for (let n = 1; n < 1000; n += 1) {
    const destination = n === 1 ? path.join(dir, name) : path.join(dir, `${stem} (${n})${ext}`);
    const partial = `${destination}.part`;
    if (fs.existsSync(destination)) continue;
    try {
      return { destination, partial, handle: fs.openSync(partial, 'wx') };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error('Too many downloads of that name are already here.');
}

function readBody(response: Electron.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    response.on('error', () => resolve(Buffer.concat(chunks).toString('utf-8')));
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

  const total = stat.size;

  return new Promise((resolve) => {
    // The body is the file's raw bytes and the destination rides the query
    // string. Multipart would mean hand-writing a streaming encoder here, and
    // on the server it would mean FastAPI parsing and spooling the whole body
    // to disk before it had even authenticated the caller.
    const url = new URL('/drive/files', req.baseUrl);
    url.searchParams.set('name', req.name);
    if (req.parentId !== null) url.searchParams.set('parent_id', String(req.parentId));
    if (req.overwrite) url.searchParams.set('overwrite', 'true');

    const request = net.request({ method: 'POST', url: url.toString() });
    request.setHeader('Authorization', `Bearer ${req.token}`);
    request.setHeader('Content-Type', 'application/octet-stream');
    // Electron's own advice for a large body: without this the request is
    // buffered in the main process rather than streamed.
    request.chunkedEncoding = true;

    let settled = false;
    let cancelled = false;
    const source = fs.createReadStream(req.localPath);

    /**
     * Stop everything, once.
     *
     * Both halves matter. Destroying the read stream is what releases the file
     * handle — a paused stream waiting on a write callback that will never
     * resume would otherwise sit open forever. Aborting the request is what
     * stops a server that refused mid-body from being fed the rest of the file.
     */
    const stop = () => {
      source.destroy();
      try {
        request.abort();
      } catch {
        // Already finished.
      }
    };

    const finish = (result: { node?: unknown; error?: string; cancelled?: boolean }) => {
      if (settled) return;
      settled = true;
      inFlight.delete(id);
      stop();
      resolve(result);
    };

    inFlight.set(id, () => {
      cancelled = true;
      stop();
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

    let sent = 0;
    source.on('data', (chunk: Buffer) => {
      if (cancelled || settled) return;
      // Backpressure. A local disk feeds far faster than a network socket, so
      // writing without waiting buffers the whole file inside the main process
      // — the one thing streaming was for. `write`'s callback fires when the
      // chunk is flushed, and Electron's ClientRequest has no `drain` event to
      // use instead.
      source.pause();
      request.write(chunk, undefined, () => {
        if (!cancelled && !settled) source.resume();
      });
      sent += chunk.length;
      emitProgress(event, { id, loaded: sent, total });
    });
    source.on('end', () => {
      if (cancelled || settled) return;
      request.end();
    });
    source.on('error', (error) => {
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
  let claim: { destination: string; partial: string; handle: number };
  try {
    // Written under a partial name and renamed at the end, so an interrupted
    // download never looks like a complete file.
    claim = claimDestination(dir, safeLocalName(req.fileName));
  } catch (error) {
    return { error: (error as Error).message };
  }

  return new Promise((resolve) => {
    const url = new URL(`/drive/files/${req.nodeId}/content`, req.baseUrl);
    const request = net.request({ method: 'GET', url: url.toString() });
    request.setHeader('Authorization', `Bearer ${req.token}`);

    let settled = false;
    let cancelled = false;
    const sink = fs.createWriteStream('', { fd: claim.handle });

    const finish = (result: { path?: string; error?: string; cancelled?: boolean }) => {
      if (settled) return;
      settled = true;
      inFlight.delete(id);
      if (result.path === undefined) {
        sink.destroy();
        try {
          request.abort();
        } catch {
          // Already finished.
        }
        try {
          fs.rmSync(claim.partial, { force: true });
        } catch {
          // Nothing to remove.
        }
      }
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

    sink.on('error', (error) => finish({ error: error.message }));

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

      // Electron's IncomingMessage implements the Readable interface — its
      // typings say only EventEmitter — and piping is what gives backpressure:
      // writing every chunk as it arrives would buffer a file the disk cannot
      // keep up with in main-process memory, which is what this module exists
      // to avoid.
      const readable = response as unknown as NodeJS.ReadableStream;
      readable.pipe(sink);
      readable.on('data', (chunk: Buffer) => {
        received += chunk.length;
        emitProgress(event, { id, loaded: received, total });
      });
      readable.on('error', (error: Error) => finish({ error: error.message }));

      sink.on('finish', () => {
        if (cancelled) {
          finish({ cancelled: true });
          return;
        }
        try {
          fs.renameSync(claim.partial, claim.destination);
          finish({ path: claim.destination });
        } catch (error) {
          finish({ error: (error as Error).message });
        }
      });
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
