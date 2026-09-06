/**
 * One explorer, two roots.
 *
 * Every path in this app is a bare string with no scheme — `FileEntry.fullPath`,
 * `OpenFile.path`, `workspaceRoot`, selection ids, chat chips — and tab dedupe
 * and selection ids compare those strings directly. So the drive threads through
 * the whole client as a prefix rather than as a parallel set of components:
 * anything starting `drive://` is on the server, everything else is on this
 * machine, and this module is the only place that has to know which.
 *
 * It exposes the same surface as `window.electron.explorer`, so every call site
 * swaps one identifier and keeps working. Local paths pass straight through to
 * the Electron bridge, unchanged.
 *
 * ## Ids, not paths
 *
 * The server addresses nodes by id and never builds a filesystem path out of
 * anything a client sends. The explorer is path-shaped. This module bridges the
 * two, and is the only thing that knows a node id exists: it remembers ids as it
 * lists folders and falls back to `GET /drive/resolve` for a path it has not
 * seen — a deep link, or the first render after a reload.
 *
 * ## Separators
 *
 * Local paths use the host separator; drive paths are always `/`, on every
 * platform. Four modules used to derive a module-level `SEP` from
 * `window.electron.platform` and join with it, which is wrong for a drive path
 * on Windows. `joinPath`/`dirnameOf`/`basenameOf` here pick the separator from
 * the path itself, and are the only ones the explorer uses.
 */

import { apiClient } from './client';
import type { DriveNode } from './types';
import type { FileEntry } from '../store/explorerStore';

export const DRIVE_SCHEME = 'drive://';

/** The drive's root, as it appears in `FileEntry.fullPath`. */
export const DRIVE_ROOT = DRIVE_SCHEME;

export const DRIVE_ROOT_LABEL = 'Kurisu Drive';
export const LOCAL_ROOT_LABEL = 'This computer';

export function isDrivePath(path: string): boolean {
  return typeof path === 'string' && path.startsWith(DRIVE_SCHEME);
}

/** `drive://Reports/Q3.md` → `['Reports', 'Q3.md']`; the root → `[]`. */
export function drivePathSegments(path: string): string[] {
  return path.slice(DRIVE_SCHEME.length).split('/').filter(Boolean);
}

/** `drive://Reports/Q3.md` → `/Reports/Q3.md`, the form the API speaks. */
export function driveApiPath(path: string): string {
  return '/' + drivePathSegments(path).join('/');
}

/** `/Reports/Q3.md` → `drive://Reports/Q3.md`. */
export function driveClientPath(apiPath: string): string {
  return DRIVE_SCHEME + apiPath.split('/').filter(Boolean).join('/');
}

function localSeparator(): string {
  return (window.electron?.platform ?? 'win32') === 'win32' ? '\\' : '/';
}

/** Join a directory and a child name, using the separator the path implies. */
export function joinPath(dir: string, name: string): string {
  if (isDrivePath(dir)) {
    const segments = drivePathSegments(dir);
    return DRIVE_SCHEME + [...segments, name].join('/');
  }
  const sep = localSeparator();
  return dir.endsWith(sep) || dir.endsWith('/') ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** The parent of a path. The drive root is its own parent, as `/` is locally. */
export function dirnameOf(path: string): string {
  if (isDrivePath(path)) {
    const segments = drivePathSegments(path);
    segments.pop();
    return DRIVE_SCHEME + segments.join('/');
  }
  return path.replace(/[\\/][^\\/]+$/, '');
}

export function basenameOf(path: string): string {
  if (isDrivePath(path)) {
    const segments = drivePathSegments(path);
    return segments[segments.length - 1] ?? DRIVE_ROOT_LABEL;
  }
  const match = path.match(/[^\\/]+$/);
  return match ? match[0] : path;
}

/** Where a path lives, for the explorer's "Where it lives" column. */
export function locationOf(path: string): 'drive' | 'local' {
  return isDrivePath(path) ? 'drive' : 'local';
}

// ── node id cache ───────────────────────────────────────────────────────────
//
// Filled as folders are listed, so ordinary navigation never needs a lookup.
// Cleared on sign-out, because ids are per account.

const idByPath = new Map<string, number>();

export function rememberNode(path: string, id: number): void {
  idByPath.set(path, id);
}

export function forgetDriveCache(): void {
  idByPath.clear();
}

/** The node id for a drive path, resolving against the server if unseen. */
export async function driveNodeId(path: string): Promise<number | null> {
  if (drivePathSegments(path).length === 0) return null; // the root has no row
  const cached = idByPath.get(path);
  if (cached !== undefined) return cached;
  const node = await apiClient.resolveDrivePath(driveApiPath(path));
  idByPath.set(path, node.id);
  return node.id;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot);
}

function toEntry(parentPath: string, node: DriveNode): FileEntry {
  const fullPath = joinPath(parentPath, node.name);
  idByPath.set(fullPath, node.id);
  return {
    name: node.name,
    fullPath,
    type: node.is_dir ? 'directory' : 'file',
    size: node.size,
    modified: node.updated_at,
    extension: node.is_dir ? '' : extensionOf(node.name),
  };
}

/**
 * What the user should read when a call fails.
 *
 * The server's `detail` is written for a person — "'notes.md' already exists
 * here", "Your drive is full" — so it is the useful half of an axios error.
 */
function describeError(error: unknown): string {
  const response = (error as { response?: { data?: { detail?: unknown }; status?: number } })
    ?.response;
  const detail = response?.data?.detail;
  if (typeof detail === 'string' && detail) return detail;
  if (response?.status === 404) return 'Not found on Kurisu Drive.';
  if (error instanceof Error && error.message) return error.message;
  return 'Kurisu Drive could not be reached.';
}

// ── the surface ─────────────────────────────────────────────────────────────

export interface ListResult {
  path: string;
  entries: FileEntry[];
  isRoot: boolean;
  error?: string;
}

const driveRootEntry: FileEntry = {
  name: DRIVE_ROOT_LABEL,
  fullPath: DRIVE_ROOT,
  type: 'directory',
  size: 0,
  modified: null,
  extension: '',
};

export const fileSource = {
  isDrivePath,
  joinPath,
  dirnameOf,
  basenameOf,
  locationOf,

  /**
   * List a directory.
   *
   * With no path this is the root listing, and it is composed **here** rather
   * than in the main process: `electron/explorerIPC.ts` enumerates the machine's
   * own drives and cannot know anything about a server, so the drive is appended
   * on this side.
   */
  async listDirectory(dirPath: string): Promise<ListResult> {
    if (!dirPath) {
      const local = await window.electron.explorer.listDirectory('');
      return {
        path: '',
        entries: [...(local.entries ?? []), driveRootEntry],
        isRoot: true,
      };
    }

    if (!isDrivePath(dirPath)) {
      return window.electron.explorer.listDirectory(dirPath);
    }

    try {
      const parentId = await driveNodeId(dirPath);
      const nodes = await apiClient.listDriveNodes(parentId);
      return {
        path: dirPath,
        entries: nodes.map((node) => toEntry(dirPath, node)),
        isRoot: false,
      };
    } catch (error) {
      return { path: dirPath, entries: [], isRoot: false, error: describeError(error) };
    }
  },

  async readFile(filePath: string): Promise<{ content?: string; path?: string; error?: string }> {
    if (!isDrivePath(filePath)) return window.electron.explorer.readFile(filePath);
    try {
      const id = await driveNodeId(filePath);
      if (id === null) return { error: 'That is the drive itself, not a file.' };
      const blob = await apiClient.readDriveFile(id);
      return { content: await blob.text(), path: filePath };
    } catch (error) {
      return { error: describeError(error) };
    }
  },

  async writeFile(
    filePath: string,
    content: string,
  ): Promise<{ status?: string; path?: string; error?: string }> {
    if (!isDrivePath(filePath)) return window.electron.explorer.writeFile(filePath, content);
    try {
      const id = await driveNodeId(filePath);
      if (id === null) return { error: 'That is the drive itself, not a file.' };
      await apiClient.writeDriveFile(id, content);
      return { status: 'ok', path: filePath };
    } catch (error) {
      return { error: describeError(error) };
    }
  },

  /**
   * Whether a file should open in the editor at all.
   *
   * Locally this reads the first 512 bytes and looks for a NUL. Downloading a
   * drive file to answer the same question would mean fetching it twice, so the
   * stored MIME type answers instead — which is what the server guessed from the
   * extension, and is the same information the local check approximates.
   */
  async isBinary(filePath: string): Promise<boolean> {
    if (!isDrivePath(filePath)) return window.electron.explorer.isBinary(filePath);
    try {
      const id = await driveNodeId(filePath);
      if (id === null) return false;
      const node = await apiClient.getDriveNode(id);
      const mime = node.mime ?? '';
      return !(mime.startsWith('text/') || TEXTUAL_MIMES.has(mime));
    } catch {
      return false;
    }
  },

  async createFile(filePath: string): Promise<{ status?: string; path?: string; error?: string }> {
    if (!isDrivePath(filePath)) return window.electron.explorer.createFile(filePath);
    try {
      const parentId = await driveNodeId(dirnameOf(filePath));
      const node = await apiClient.uploadDriveFile(
        parentId,
        basenameOf(filePath),
        new Blob([''], { type: 'text/plain' }),
      );
      rememberNode(filePath, node.id);
      return { status: 'ok', path: filePath };
    } catch (error) {
      return { error: describeError(error) };
    }
  },

  async createFolder(dirPath: string): Promise<{ status?: string; path?: string; error?: string }> {
    if (!isDrivePath(dirPath)) return window.electron.explorer.createFolder(dirPath);
    try {
      const parentId = await driveNodeId(dirnameOf(dirPath));
      const node = await apiClient.createDriveFolder(parentId, basenameOf(dirPath));
      rememberNode(dirPath, node.id);
      return { status: 'ok', path: dirPath };
    } catch (error) {
      return { error: describeError(error) };
    }
  },

  async rename(
    oldPath: string,
    newPath: string,
  ): Promise<{ status?: string; error?: string }> {
    if (!isDrivePath(oldPath)) return window.electron.explorer.rename(oldPath, newPath);
    if (!isDrivePath(newPath)) {
      // Renaming across the two roots is a copy, not a rename: the bytes have to
      // move. The explorer offers that as Upload/Download instead.
      return { error: 'Move a file between the drive and this computer with Upload or Download.' };
    }
    try {
      const id = await driveNodeId(oldPath);
      if (id === null) return { error: 'The drive itself cannot be renamed.' };
      const changes: { name?: string; parent_id?: number | null } = {};
      if (basenameOf(oldPath) !== basenameOf(newPath)) changes.name = basenameOf(newPath);
      const oldParent = dirnameOf(oldPath);
      const newParent = dirnameOf(newPath);
      if (oldParent !== newParent) changes.parent_id = await driveNodeId(newParent);
      await apiClient.updateDriveNode(id, changes);
      idByPath.delete(oldPath);
      rememberNode(newPath, id);
      return { status: 'ok' };
    } catch (error) {
      return { error: describeError(error) };
    }
  },

  async delete(targetPath: string): Promise<{ status?: string; error?: string }> {
    if (!isDrivePath(targetPath)) return window.electron.explorer.delete(targetPath);
    try {
      const id = await driveNodeId(targetPath);
      if (id === null) return { error: 'The drive itself cannot be deleted.' };
      await apiClient.deleteDriveNode(id);
      idByPath.delete(targetPath);
      return { status: 'ok' };
    } catch (error) {
      return { error: describeError(error) };
    }
  },

  async copy(srcPath: string, destPath: string): Promise<{ status?: string; error?: string }> {
    if (!isDrivePath(srcPath) && !isDrivePath(destPath)) {
      return window.electron.explorer.copy(srcPath, destPath);
    }
    // Copying onto or off the drive moves bytes over the network, which belongs
    // in the transfer tray where it can be watched and cancelled — not in a
    // paste that blocks with no feedback.
    return { error: 'Use Upload or Download to copy between the drive and this computer.' };
  },

  /** Content search is local-only for now; the drive has no search endpoint. */
  supportsSearch(path: string): boolean {
    return !isDrivePath(path);
  },
};

/**
 * Types the editor can open even though they are not `text/*`.
 *
 * `mimetypes` calls JSON `application/json` and Markdown `text/markdown`; the
 * first would otherwise land in the binary warning.
 */
const TEXTUAL_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-yaml',
  'application/x-sh',
  'application/toml',
  'application/sql',
]);
