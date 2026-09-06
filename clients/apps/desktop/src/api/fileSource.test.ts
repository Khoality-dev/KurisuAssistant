import { installBridge, resetBridge } from '@kurisu/platform/testing';
import type { ExplorerAPI } from '@kurisu/platform';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./client', () => ({
  apiClient: {
    listDriveNodes: vi.fn(),
    getDriveNode: vi.fn(),
    readDriveFileHead: vi.fn(),
    resolveDrivePath: vi.fn(),
    createDriveFolder: vi.fn(),
    uploadDriveFile: vi.fn(),
    writeDriveFile: vi.fn(),
    readDriveFile: vi.fn(),
    updateDriveNode: vi.fn(),
    deleteDriveNode: vi.fn(),
  },
}));

import { apiClient } from './client';
import {
  DRIVE_ROOT,
  basenameOf,
  dirnameOf,
  driveApiPath,
  driveClientPath,
  drivePathSegments,
  fileSource,
  forgetDriveCache,
  isDrivePath,
  joinPath,
  locationOf,
} from './fileSource';

/** The Electron bridge, so "local paths pass straight through" is checkable. */
function stubElectron(platform: 'win32' | 'linux' = 'linux') {
  const explorer = {
    listDirectory: vi.fn(async (p: string) => ({ path: p, entries: [], isRoot: p === '' })),
    readFile: vi.fn(async () => ({ content: 'local', path: 'x' })),
    writeFile: vi.fn(async () => ({ status: 'ok' })),
    isBinary: vi.fn(async () => false),
    createFile: vi.fn(async () => ({ status: 'ok' })),
    createFolder: vi.fn(async () => ({ status: 'ok' })),
    rename: vi.fn(async () => ({ status: 'ok' })),
    delete: vi.fn(async () => ({ status: 'ok' })),
    copy: vi.fn(async () => ({ status: 'ok' })),
  };
  installBridge({
    os: platform,
    files: explorer as unknown as ExplorerAPI,
    capabilities: { localFiles: true },
  });
  return explorer;
}

beforeEach(() => {
  vi.clearAllMocks();
  forgetDriveCache();
  stubElectron();
});

afterEach(() => {
  resetBridge();
});

describe('recognising a drive path', () => {
  it('is the prefix and nothing else', () => {
    expect(isDrivePath('drive://')).toBe(true);
    expect(isDrivePath('drive://Reports/Q3.md')).toBe(true);
    expect(isDrivePath('/home/kho/notes.md')).toBe(false);
    expect(isDrivePath('C:\\Users\\kho\\notes.md')).toBe(false);
    // A local folder that merely happens to be called "drive".
    expect(isDrivePath('/mnt/drive/notes.md')).toBe(false);
  });

  it('reports where a file lives, which is what the explorer column shows', () => {
    expect(locationOf('drive://Reports')).toBe('drive');
    expect(locationOf('/home/kho')).toBe('local');
  });
});

describe('drive path arithmetic', () => {
  it('splits into segments, dropping empty ones', () => {
    expect(drivePathSegments('drive://')).toEqual([]);
    expect(drivePathSegments('drive://Reports')).toEqual(['Reports']);
    expect(drivePathSegments('drive://Reports/Q3.md')).toEqual(['Reports', 'Q3.md']);
    expect(drivePathSegments('drive://Reports//weekly/')).toEqual(['Reports', 'weekly']);
  });

  it('converts to and from the API form', () => {
    expect(driveApiPath('drive://Reports/Q3.md')).toBe('/Reports/Q3.md');
    expect(driveApiPath(DRIVE_ROOT)).toBe('/');
    expect(driveClientPath('/Reports/Q3.md')).toBe('drive://Reports/Q3.md');
  });
});

describe('joining and splitting paths', () => {
  it('keeps drive paths POSIX-shaped even on Windows', () => {
    // The bug this exists to prevent: four modules derived a module-level
    // separator from the platform and joined with it, so on Windows a drive
    // path became "drive://Reports\Q3.md" and stopped resolving.
    stubElectron('win32');
    expect(joinPath('drive://Reports', 'Q3.md')).toBe('drive://Reports/Q3.md');
    expect(joinPath(DRIVE_ROOT, 'Reports')).toBe('drive://Reports');
    expect(dirnameOf('drive://Reports/Q3.md')).toBe('drive://Reports');
    expect(basenameOf('drive://Reports/Q3.md')).toBe('Q3.md');
  });

  it('uses the host separator for local paths', () => {
    stubElectron('win32');
    expect(joinPath('C:\\Users\\kho', 'notes.md')).toBe('C:\\Users\\kho\\notes.md');
    stubElectron('linux');
    expect(joinPath('/home/kho', 'notes.md')).toBe('/home/kho/notes.md');
    expect(dirnameOf('/home/kho/notes.md')).toBe('/home/kho');
    expect(basenameOf('/home/kho/notes.md')).toBe('notes.md');
  });

  it('treats the drive root as its own parent, as / is locally', () => {
    expect(dirnameOf('drive://Reports')).toBe(DRIVE_ROOT);
    expect(dirnameOf(DRIVE_ROOT)).toBe(DRIVE_ROOT);
  });
});

describe('the root listing', () => {
  it('puts Kurisu Drive beside this machine, composed in the renderer', async () => {
    // `explorerIPC` enumerates this machine's own drives and cannot know a
    // server exists, so the drive has to be appended on this side.
    const explorer = stubElectron();
    explorer.listDirectory.mockResolvedValueOnce({
      path: '',
      entries: [{ name: 'Home', fullPath: '/home/kho', type: 'directory', size: 0, modified: null, extension: '' }],
      isRoot: true,
    } as any);

    const result = await fileSource.listDirectory('');

    expect(result.isRoot).toBe(true);
    expect(result.entries.map((e) => e.name)).toEqual(['Home', 'Kurisu Drive']);
    expect(result.entries[1].fullPath).toBe(DRIVE_ROOT);
  });
});

describe('dispatching by prefix', () => {
  it('passes a local path straight through to the bridge', async () => {
    const explorer = stubElectron();
    await fileSource.readFile('/home/kho/notes.md');
    expect(explorer.readFile).toHaveBeenCalledWith('/home/kho/notes.md');
    expect(apiClient.readDriveFile).not.toHaveBeenCalled();
  });

  it('sends a drive path to the server', async () => {
    (apiClient.resolveDrivePath as any).mockResolvedValue({ id: 42 });
    (apiClient.readDriveFile as any).mockResolvedValue(new Blob(['# Q3']));

    const result = await fileSource.readFile('drive://Reports/Q3.md');

    expect(apiClient.resolveDrivePath).toHaveBeenCalledWith('/Reports/Q3.md');
    expect(apiClient.readDriveFile).toHaveBeenCalledWith(42);
    expect(result.content).toBe('# Q3');
  });
});

describe('the node id cache', () => {
  it('is filled by listing a folder, so navigation needs no lookup', async () => {
    (apiClient.listDriveNodes as any).mockResolvedValue([
      { id: 7, parent_id: null, name: 'Reports', is_dir: true, size: 0, mime: null, checksum: null, created_at: null, updated_at: null },
    ]);

    await fileSource.listDirectory(DRIVE_ROOT);
    await fileSource.listDirectory('drive://Reports');

    // The second listing used the remembered id rather than resolving again.
    expect(apiClient.resolveDrivePath).not.toHaveBeenCalled();
    expect(apiClient.listDriveNodes).toHaveBeenLastCalledWith(7);
  });

  it('falls back to the server for a path it has not seen', async () => {
    (apiClient.resolveDrivePath as any).mockResolvedValue({ id: 99 });
    (apiClient.listDriveNodes as any).mockResolvedValue([]);

    await fileSource.listDirectory('drive://Deep/Link');

    expect(apiClient.resolveDrivePath).toHaveBeenCalledWith('/Deep/Link');
    expect(apiClient.listDriveNodes).toHaveBeenCalledWith(99);
  });

  it('lists the drive root without asking the server to resolve it', async () => {
    (apiClient.listDriveNodes as any).mockResolvedValue([]);
    await fileSource.listDirectory(DRIVE_ROOT);
    // The root is the absence of a parent; there is no row to resolve.
    expect(apiClient.resolveDrivePath).not.toHaveBeenCalled();
    expect(apiClient.listDriveNodes).toHaveBeenCalledWith(null);
  });
});

describe('what the user is told when it fails', () => {
  it('shows the server\'s own sentence rather than an axios message', async () => {
    (apiClient.resolveDrivePath as any).mockResolvedValue({ id: 1 });
    (apiClient.createDriveFolder as any).mockRejectedValue({
      response: { status: 409, data: { detail: "'Reports' already exists here" } },
    });

    const result = await fileSource.createFolder('drive://Reports');
    expect(result.error).toBe("'Reports' already exists here");
  });

  it('has a fallback when the response carries nothing readable', async () => {
    (apiClient.listDriveNodes as any).mockRejectedValue(new Error('Network Error'));
    const result = await fileSource.listDirectory(DRIVE_ROOT);
    expect(result.error).toBe('Network Error');
    expect(result.entries).toEqual([]);
  });
});

describe('operations that cross the two roots', () => {
  it('refuses to rename a drive file onto the local disk', async () => {
    (apiClient.resolveDrivePath as any).mockResolvedValue({ id: 5 });
    const result = await fileSource.rename('drive://a.md', '/home/kho/a.md');
    // Moving bytes between the two is a transfer you can watch, not a rename
    // that blocks with no feedback.
    expect(result.error).toMatch(/Upload or Download/);
    expect(apiClient.updateDriveNode).not.toHaveBeenCalled();
  });

  it('refuses a copy that crosses, and says which actions do it', async () => {
    const result = await fileSource.copy('/home/kho/a.md', 'drive://a.md');
    expect(result.error).toMatch(/Upload or Download/);
  });

  it('still copies locally', async () => {
    const explorer = stubElectron();
    await fileSource.copy('/home/kho/a.md', '/home/kho/b.md');
    expect(explorer.copy).toHaveBeenCalledWith('/home/kho/a.md', '/home/kho/b.md');
  });
});

describe('rename and move on the drive', () => {
  it('sends only the fields that changed', async () => {
    (apiClient.resolveDrivePath as any).mockResolvedValue({ id: 5 });

    await fileSource.rename('drive://Reports/a.md', 'drive://Reports/b.md');

    expect(apiClient.updateDriveNode).toHaveBeenCalledWith(5, { name: 'b.md' });
  });

  it('sends the new parent when the folder changes', async () => {
    (apiClient.resolveDrivePath as any)
      .mockResolvedValueOnce({ id: 5 })   // the node being moved
      .mockResolvedValueOnce({ id: 9 });  // its new parent

    await fileSource.rename('drive://Reports/a.md', 'drive://Notes/a.md');

    expect(apiClient.updateDriveNode).toHaveBeenCalledWith(5, { parent_id: 9 });
  });
});

describe('deciding whether a drive file opens in the editor', () => {
  const head = (bytes: number[]) => new Uint8Array(bytes).buffer;

  it('sniffs the first bytes, the way the local side does', async () => {
    (apiClient.resolveDrivePath as any).mockResolvedValue({ id: 3 });

    (apiClient.readDriveFileHead as any).mockResolvedValue(head([0x23, 0x20, 0x51, 0x33]));
    expect(await fileSource.isBinary('drive://notes.md')).toBe(false);

    (apiClient.readDriveFileHead as any).mockResolvedValue(head([0x89, 0x50, 0x00, 0x0d]));
    expect(await fileSource.isBinary('drive://photo.png')).toBe(true);
  });

  it('costs 512 bytes, not the file', async () => {
    // A Range request, which is exactly what serving through FileResponse
    // bought us on the server side.
    (apiClient.resolveDrivePath as any).mockResolvedValue({ id: 3 });
    (apiClient.readDriveFileHead as any).mockResolvedValue(head([0x61]));

    await fileSource.isBinary('drive://notes.md');

    expect(apiClient.readDriveFileHead).toHaveBeenCalledWith(3, 512);
    expect(apiClient.readDriveFile).not.toHaveBeenCalled();
  });

  it('opens files whose extension says nothing', async () => {
    // The stored MIME is guessed from the extension, so a Dockerfile, a
    // Makefile, a LICENSE and every unmapped extension come back as
    // application/octet-stream. Trusting that would refuse to open files whose
    // local twins open fine.
    (apiClient.resolveDrivePath as any).mockResolvedValue({ id: 3 });
    (apiClient.readDriveFileHead as any).mockResolvedValue(
      head([0x46, 0x52, 0x4f, 0x4d, 0x20, 0x6e]),
    );

    expect(await fileSource.isBinary('drive://Dockerfile')).toBe(false);
    expect(await fileSource.isBinary('drive://LICENSE')).toBe(false);
  });

  it('calls it text when the sniff itself fails', async () => {
    // Otherwise a network blip shows the binary warning for an ordinary file;
    // `readFile` reports the real error instead.
    (apiClient.resolveDrivePath as any).mockResolvedValue({ id: 3 });
    (apiClient.readDriveFileHead as any).mockRejectedValue(new Error('offline'));
    expect(await fileSource.isBinary('drive://notes.md')).toBe(false);
  });
});

describe('search', () => {
  it('is offered on this machine and not on the drive', () => {
    // ripgrep runs locally; there is no drive-side search yet (#6). Offering it
    // would search the wrong tree.
    expect(fileSource.supportsSearch('/home/kho')).toBe(true);
    expect(fileSource.supportsSearch('drive://Reports')).toBe(false);
  });
});

describe('forgetting cached ids', () => {
  async function cacheReportsTree() {
    (apiClient.listDriveNodes as any)
      .mockResolvedValueOnce([
        { id: 7, parent_id: null, name: 'Reports', is_dir: true, size: 0, mime: null, checksum: null, created_at: null, updated_at: null },
      ])
      .mockResolvedValueOnce([
        { id: 8, parent_id: 7, name: 'Q3.md', is_dir: false, size: 1, mime: 'text/markdown', checksum: null, created_at: null, updated_at: null },
      ]);
    await fileSource.listDirectory(DRIVE_ROOT);
    await fileSource.listDirectory('drive://Reports');
  }

  it('drops a deleted folder\'s children, not just the folder', async () => {
    // Otherwise a new folder of the same name holding a file of the same name
    // resolves to the deleted node's id — the wrong file, silently.
    await cacheReportsTree();
    (apiClient.deleteDriveNode as any).mockResolvedValue(undefined);

    await fileSource.delete('drive://Reports');

    (apiClient.resolveDrivePath as any).mockResolvedValue({ id: 99 });
    (apiClient.readDriveFile as any).mockResolvedValue(new Blob(['new']));
    await fileSource.readFile('drive://Reports/Q3.md');

    expect(apiClient.resolveDrivePath).toHaveBeenCalledWith('/Reports/Q3.md');
    expect(apiClient.readDriveFile).toHaveBeenCalledWith(99);
  });

  it('drops a renamed folder\'s children too', async () => {
    await cacheReportsTree();
    (apiClient.updateDriveNode as any).mockResolvedValue({ id: 7 });

    await fileSource.rename('drive://Reports', 'drive://Archive');

    (apiClient.resolveDrivePath as any).mockResolvedValue({ id: 55 });
    (apiClient.readDriveFile as any).mockResolvedValue(new Blob(['x']));
    await fileSource.readFile('drive://Reports/Q3.md');

    expect(apiClient.readDriveFile).toHaveBeenCalledWith(55);
  });

  it('is emptied outright when the account changes', async () => {
    await cacheReportsTree();
    forgetDriveCache();

    (apiClient.resolveDrivePath as any).mockResolvedValue({ id: 1000 });
    (apiClient.listDriveNodes as any).mockResolvedValue([]);
    await fileSource.listDirectory('drive://Reports');

    expect(apiClient.resolveDrivePath).toHaveBeenCalledWith('/Reports');
  });
});

describe('moving between the two roots', () => {
  it('refuses a rename in either direction, not just off the drive', async () => {
    const explorer = stubElectron();
    (apiClient.resolveDrivePath as any).mockResolvedValue({ id: 5 });

    const off = await fileSource.rename('drive://a.md', '/home/kho/a.md');
    const onto = await fileSource.rename('/home/kho/a.md', 'drive://a.md');

    expect(off.error).toMatch(/Upload or Download/);
    // Without the second check this fell through to the Electron rename and
    // made a *local* file literally called "drive://a.md".
    expect(onto.error).toMatch(/Upload or Download/);
    expect(explorer.rename).not.toHaveBeenCalled();
  });
});
