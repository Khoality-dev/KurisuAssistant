// @vitest-environment node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrateUserDataDirectory } from '../electron/userDataMigration';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amadeus-user-data-test-'));
  roots.push(root);
  return root;
}

describe('user-data folder migration', () => {
  it('copies kurisu-assistant to amadeus and leaves the source in place', () => {
    const appData = scratch();
    const source = path.join(appData, 'kurisu-assistant');
    fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(source, 'nested', 'settings.json'), '{"theme":"dark"}');

    const target = migrateUserDataDirectory(appData);

    expect(target).toBe(path.join(appData, 'amadeus'));
    expect(fs.readFileSync(path.join(target, 'nested', 'settings.json'), 'utf8')).toContain('dark');
    expect(fs.existsSync(source)).toBe(true);
  });

  it('does not merge into or overwrite an existing Amadeus directory', () => {
    const appData = scratch();
    fs.mkdirSync(path.join(appData, 'kurisu-assistant'), { recursive: true });
    fs.writeFileSync(path.join(appData, 'kurisu-assistant', 'value'), 'old');
    fs.mkdirSync(path.join(appData, 'amadeus'), { recursive: true });
    fs.writeFileSync(path.join(appData, 'amadeus', 'value'), 'new');

    migrateUserDataDirectory(appData);

    expect(fs.readFileSync(path.join(appData, 'amadeus', 'value'), 'utf8')).toBe('new');
  });

  it('starts anyway when the copy fails, and leaves nothing half-copied', () => {
    // The old app may still be running and hold its files open (EBUSY on Windows).
    const appData = scratch();
    fs.mkdirSync(path.join(appData, 'kurisu-assistant'), { recursive: true });
    fs.writeFileSync(path.join(appData, 'kurisu-assistant', 'value'), 'old');
    vi.spyOn(fs, 'cpSync').mockImplementation((_src, dest) => {
      fs.mkdirSync(String(dest), { recursive: true });
      fs.writeFileSync(path.join(String(dest), 'partial'), 'x');
      throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
    });

    const target = migrateUserDataDirectory(appData);

    expect(target).toBe(path.join(appData, 'amadeus'));
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(appData).sort()).toEqual(['kurisu-assistant']);
  });
});
