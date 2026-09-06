import { installBridge, resetBridge } from '@kurisu/platform/testing';
import type { DriveTransferAPI } from '@kurisu/platform';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/client', () => ({
  apiClient: { getToken: () => 'test-token' },
}));

vi.mock('../config', () => ({
  config: { apiBaseUrl: 'http://mock:15597' },
}));

vi.mock('../api/fileSource', async () => {
  const actual = await vi.importActual<typeof import('../api/fileSource')>('../api/fileSource');
  return {
    ...actual,
    driveNodeId: vi.fn(async (path: string) => (path === 'drive://' ? null : 7)),
    rememberNode: vi.fn(),
  };
});

import { driveNodeId } from '../api/fileSource';
import { resetTransferSubscription, useTransferStore } from './transferStore';

let progressListener: ((p: { id: string; loaded: number; total: number | null }) => void) | null = null;

function stubDriveBridge() {
  const drive = {
    pathForFile: vi.fn((f: any) => `/home/kho/${f.name}`),
    pickFiles: vi.fn(),
    upload: vi.fn(),
    download: vi.fn(),
    cancel: vi.fn(async () => ({ cancelled: true })),
    onTransferProgress: vi.fn((cb: any) => {
      progressListener = cb;
      return () => {};
    }),
  };
  installBridge({
    os: 'linux',
    transfers: drive as unknown as DriveTransferAPI,
    capabilities: { transferProgress: true },
  });
  return drive;
}

function reset() {
  useTransferStore.setState({ transfers: [], isTrayOpen: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetTransferSubscription();
  reset();
});

afterEach(() => {
  resetBridge();
  progressListener = null;
});

describe('an upload', () => {
  it('opens the tray and shows the file before any bytes move', async () => {
    const drive = stubDriveBridge();
    let resolveUpload: (v: unknown) => void = () => {};
    drive.upload.mockReturnValue(new Promise((r) => { resolveUpload = r; }));

    const pending = useTransferStore.getState().upload('/home/kho/report.pdf', 'drive://Reports', {
      name: 'report.pdf',
      size: 2048,
    });

    // The tray is the feedback. A transfer that only appears once it finishes
    // is a transfer the user thinks did not start.
    const state = useTransferStore.getState();
    expect(state.isTrayOpen).toBe(true);
    expect(state.transfers).toHaveLength(1);
    expect(state.transfers[0]).toMatchObject({
      direction: 'up',
      name: 'report.pdf',
      status: 'active',
      bytes: 2048,
      note: 'to Kurisu Drive / Reports',
    });

    resolveUpload({ node: { id: 11, name: 'report.pdf', size: 2048 } });
    await pending;
  });

  it('streams through the main process with the caller\'s token', async () => {
    const drive = stubDriveBridge();
    drive.upload.mockResolvedValue({ node: { id: 11, name: 'report.pdf', size: 2048 } });

    await useTransferStore.getState().upload('/home/kho/report.pdf', 'drive://Reports', { size: 2048 });

    expect(drive.upload).toHaveBeenCalledWith(expect.any(String), {
      baseUrl: 'http://mock:15597',
      token: 'test-token',
      localPath: '/home/kho/report.pdf',
      parentId: 7,
      name: 'report.pdf',
      overwrite: undefined,
    });
  });

  it('uploads to the top of the drive with no parent id', async () => {
    const drive = stubDriveBridge();
    drive.upload.mockResolvedValue({ node: { id: 11, name: 'a.md', size: 3 } });

    await useTransferStore.getState().upload('/home/kho/a.md', 'drive://');

    expect(drive.upload.mock.calls[0][1].parentId).toBeNull();
  });

  it('records the server\'s refusal on the row rather than swallowing it', async () => {
    const drive = stubDriveBridge();
    drive.upload.mockResolvedValue({ error: 'Your drive is full.' });

    await useTransferStore.getState().upload('/home/kho/big.bin', 'drive://', { size: 9 });

    const [transfer] = useTransferStore.getState().transfers;
    expect(transfer.status).toBe('failed');
    expect(transfer.error).toBe('Your drive is full.');
  });

  it('says so when the destination folder is gone', async () => {
    stubDriveBridge();
    (driveNodeId as any).mockRejectedValueOnce(new Error('404'));

    await useTransferStore.getState().upload('/home/kho/a.md', 'drive://Ghost');

    expect(useTransferStore.getState().transfers[0]).toMatchObject({
      status: 'failed',
      error: 'That folder is no longer on the drive.',
    });
  });
});

describe('a download', () => {
  it('goes to the machine\'s Downloads folder', async () => {
    const drive = stubDriveBridge();
    drive.download.mockResolvedValue({ path: '/home/kho/Downloads/Q3.md' });

    const saved = await useTransferStore.getState().download('drive://Reports/Q3.md', { size: 18 });

    expect(saved).toBe('/home/kho/Downloads/Q3.md');
    expect(drive.download).toHaveBeenCalledWith(expect.any(String), {
      baseUrl: 'http://mock:15597',
      token: 'test-token',
      nodeId: 7,
      fileName: 'Q3.md',
    });
    expect(useTransferStore.getState().transfers[0]).toMatchObject({
      status: 'done',
      note: 'saved to /home/kho/Downloads',
    });
  });

  it('refuses to download the drive itself', async () => {
    stubDriveBridge();
    const saved = await useTransferStore.getState().download('drive://');
    expect(saved).toBeNull();
    expect(useTransferStore.getState().transfers[0].status).toBe('failed');
  });
});

describe('progress', () => {
  it('is applied to the row it names, and to no other', async () => {
    const drive = stubDriveBridge();
    let finish: (v: unknown) => void = () => {};
    drive.upload.mockReturnValue(new Promise((r) => { finish = r; }));

    const pending = useTransferStore.getState().upload('/home/kho/a.bin', 'drive://', { size: 1000 });
    const id = useTransferStore.getState().transfers[0].id;

    progressListener?.({ id, loaded: 400, total: 1000 });
    expect(useTransferStore.getState().transfers[0].transferred).toBe(400);

    progressListener?.({ id: 'some-other-transfer', loaded: 999, total: 1000 });
    expect(useTransferStore.getState().transfers[0].transferred).toBe(400);

    finish({ node: { id: 1, name: 'a.bin', size: 1000 } });
    await pending;
  });
});

describe('the tray', () => {
  it('counts only what is still moving', () => {
    useTransferStore.setState({
      transfers: [
        { id: 'a', direction: 'up', name: 'a', note: '', bytes: 1, transferred: 0, status: 'active' },
        { id: 'b', direction: 'up', name: 'b', note: '', bytes: 1, transferred: 1, status: 'done' },
        { id: 'c', direction: 'down', name: 'c', note: '', bytes: 1, transferred: 0, status: 'failed' },
      ],
    });
    expect(useTransferStore.getState().activeCount()).toBe(1);
  });

  it('clears what has finished and keeps what has not', () => {
    useTransferStore.setState({
      transfers: [
        { id: 'a', direction: 'up', name: 'a', note: '', bytes: 1, transferred: 0, status: 'active' },
        { id: 'b', direction: 'up', name: 'b', note: '', bytes: 1, transferred: 1, status: 'done' },
        { id: 'c', direction: 'down', name: 'c', note: '', bytes: 1, transferred: 0, status: 'cancelled' },
      ],
    });

    useTransferStore.getState().clearFinished();

    expect(useTransferStore.getState().transfers.map((t) => t.id)).toEqual(['a']);
  });

  it('cancels through the main process and marks the row', async () => {
    const drive = stubDriveBridge();
    useTransferStore.setState({
      transfers: [
        { id: 'a', direction: 'up', name: 'a', note: '', bytes: 1, transferred: 0, status: 'active' },
      ],
    });

    await useTransferStore.getState().cancel('a');

    expect(drive.cancel).toHaveBeenCalledWith('a');
    expect(useTransferStore.getState().transfers[0].status).toBe('cancelled');
  });
});
