import { create } from 'zustand';
import { apiClient } from '@kurisu/api';
import { config } from '@kurisu/api';
import {
  basenameOf,
  dirnameOf,
  driveNodeId,
  joinPath,
  rememberNode,
} from '@kurisu/api';
import type { DriveNode } from '@kurisu/models';
import { resolveBridge } from '@kurisu/platform';

/**
 * Uploads and downloads, and the tray that shows them.
 *
 * Transfers are deliberately *not* modal. A dialog that blocks the window while
 * a gigabyte moves is the thing this replaces: a transfer starts, the explorer
 * stays usable, and progress, failures and cancels all live in one tray.
 *
 * The bytes themselves never pass through here. `electron/driveTransfers.ts`
 * streams them in the main process and reports progress over IPC; this store
 * holds the rows and the lifecycle.
 */

export type TransferDirection = 'up' | 'down';
export type TransferStatus = 'active' | 'done' | 'failed' | 'cancelled';

export interface Transfer {
  id: string;
  direction: TransferDirection;
  name: string;
  /** Where it is going, in words: "Kurisu Drive / Reports", "Downloads". */
  note: string;
  bytes: number | null;
  transferred: number;
  status: TransferStatus;
  error?: string;
  /** Where an upload landed, so the explorer can show it without a refetch. */
  destinationPath?: string;
}

interface TransferState {
  transfers: Transfer[];
  isTrayOpen: boolean;

  toggleTray: (open?: boolean) => void;
  clearFinished: () => void;
  cancel: (id: string) => Promise<void>;

  /** Upload one local file into a drive folder. Returns the new node, or null. */
  upload: (
    localPath: string,
    destinationFolder: string,
    options?: { name?: string; size?: number; overwrite?: boolean },
  ) => Promise<DriveNode | null>;

  /** Download a drive file into the machine's Downloads folder. */
  download: (drivePath: string, options?: { size?: number }) => Promise<string | null>;

  activeCount: () => number;
}

let sequence = 0;
function nextId(): string {
  sequence += 1;
  return `t${sequence}`;
}

/** "Kurisu Drive" for the root, "Kurisu Drive / Reports" for a folder in it. */
function describeFolder(path: string): string {
  const label = basenameOf(path);
  return label === 'Kurisu Drive' ? label : `Kurisu Drive / ${label}`;
}

/**
 * The host's transfer service.
 *
 * Streaming a file belongs to the host — the renderer must never hold a
 * gigabyte — so a host that cannot do it has no business being asked. Callers
 * reach this only from paths a `capabilities.transferProgress` check has
 * already opened.
 */
function hostTransfers() {
  const transfers = resolveBridge().transfers;
  if (!transfers) throw new Error('this host does not transfer files');
  return transfers;
}

let progressSubscribed = false;

/**
 * Start listening for progress, once.
 *
 * Lazily rather than when the module loads: the bridge is only there after
 * preload has run, and a subscription taken at import time silently does
 * nothing when it has not. One listener for the store's lifetime — a listener
 * per transfer would leak a closure per file.
 */
function ensureProgressSubscription(
  set: (fn: (state: TransferState) => Partial<TransferState>) => void,
): void {
  const transfers = resolveBridge().transfers;
  if (progressSubscribed || !transfers) return;
  progressSubscribed = true;
  transfers.onTransferProgress(({ id, loaded, total }) => {
    set((state) => ({
      transfers: state.transfers.map((t) =>
        t.id === id ? { ...t, transferred: loaded, bytes: total ?? t.bytes } : t,
      ),
    }));
  });
}

/** Test seam: forget the subscription so a fresh bridge stub is picked up. */
export function resetTransferSubscription(): void {
  progressSubscribed = false;
}

export const useTransferStore = create<TransferState>((set, get) => {
  const patch = (id: string, changes: Partial<Transfer>) =>
    set((state) => ({
      transfers: state.transfers.map((t) => (t.id === id ? { ...t, ...changes } : t)),
    }));

  return {
    transfers: [],
    isTrayOpen: false,

    toggleTray: (open) =>
      set((state) => ({ isTrayOpen: open ?? !state.isTrayOpen })),

    clearFinished: () =>
      set((state) => ({ transfers: state.transfers.filter((t) => t.status === 'active') })),

    cancel: async (id) => {
      await hostTransfers().cancel(id);
      patch(id, { status: 'cancelled' });
    },

    upload: async (localPath, destinationFolder, options = {}) => {
      ensureProgressSubscription(set);
      const name = options.name ?? basenameOf(localPath);
      const id = nextId();

      set((state) => ({
        isTrayOpen: true,
        transfers: [
          {
            id,
            direction: 'up',
            name,
            note: `to ${describeFolder(destinationFolder)}`,
            bytes: options.size ?? null,
            transferred: 0,
            status: 'active',
            destinationPath: joinPath(destinationFolder, name),
          },
          ...state.transfers,
        ],
      }));

      let parentId: number | null;
      try {
        parentId = await driveNodeId(destinationFolder);
      } catch {
        patch(id, { status: 'failed', error: 'That folder is no longer on the drive.' });
        return null;
      }

      const result = await hostTransfers().upload(id, {
        baseUrl: config.apiBaseUrl,
        token: apiClient.getToken() ?? '',
        localPath,
        parentId,
        name,
        overwrite: options.overwrite,
      });

      if (result.cancelled) {
        patch(id, { status: 'cancelled' });
        return null;
      }
      if (result.error || !result.node) {
        patch(id, { status: 'failed', error: result.error ?? 'The upload failed.' });
        return null;
      }

      const node = result.node as DriveNode;
      rememberNode(joinPath(destinationFolder, node.name), node.id);
      patch(id, {
        status: 'done',
        transferred: node.size,
        bytes: node.size,
        destinationPath: joinPath(destinationFolder, node.name),
      });
      return node;
    },

    download: async (drivePath, options = {}) => {
      ensureProgressSubscription(set);
      const name = basenameOf(drivePath);
      const id = nextId();

      set((state) => ({
        isTrayOpen: true,
        transfers: [
          {
            id,
            direction: 'down',
            name,
            note: 'to Downloads',
            bytes: options.size ?? null,
            transferred: 0,
            status: 'active',
          },
          ...state.transfers,
        ],
      }));

      let nodeId: number | null;
      try {
        nodeId = await driveNodeId(drivePath);
      } catch {
        patch(id, { status: 'failed', error: 'That file is no longer on the drive.' });
        return null;
      }
      if (nodeId === null) {
        patch(id, { status: 'failed', error: 'That is the drive itself, not a file.' });
        return null;
      }

      const result = await hostTransfers().download(id, {
        baseUrl: config.apiBaseUrl,
        token: apiClient.getToken() ?? '',
        nodeId,
        fileName: name,
      });

      if (result.cancelled) {
        patch(id, { status: 'cancelled' });
        return null;
      }
      if (result.error || !result.path) {
        patch(id, { status: 'failed', error: result.error ?? 'The download failed.' });
        return null;
      }

      patch(id, { status: 'done', note: `saved to ${dirnameOf(result.path)}` });
      return result.path;
    },

    activeCount: () => get().transfers.filter((t) => t.status === 'active').length,
  };
});
