/**
 * The update gate offers the update instead of asking for it (#264): one
 * button that checks, downloads and restarts; a plain sentence when this is
 * already the newest release; the release page where the install cannot
 * replace itself; and nothing offered when the server is the side behind.
 */
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installBridge, resetBridge, fakeUpdater, type FakeUpdater } from '@kurisu/platform/testing';
import { WIRE_PROTOCOL } from '@kurisu/models';
import { UpdateRequiredScreen, describeUpdateState } from './UpdateRequiredScreen';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const newerServer = { backend_version: '9.9.9', wire_protocol: WIRE_PROTOCOL + 1 };
const olderServer = { backend_version: '0.1.0', wire_protocol: WIRE_PROTOCOL - 1 };

async function render(info: { backend_version: string | null; wire_protocol: number | null }) {
  await act(async () => {
    root.render(<UpdateRequiredScreen info={info} appVersion="0.7.0" onChangeServer={() => {}} />);
  });
  // canSelfUpdate answers on a microtask.
  await act(async () => { await Promise.resolve(); });
}

const byId = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const click = async (testId: string) => {
  await act(async () => { byId(testId)!.click(); });
  await act(async () => { await Promise.resolve(); });
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  resetBridge();
});

describe('UpdateRequiredScreen', () => {
  it('offers "Update now" and walks check → download → restart when the install can update itself', async () => {
    const updater: FakeUpdater = fakeUpdater({ canSelfUpdate: true, check: { status: 'available', version: '9.9.9' } });
    installBridge({ updater, capabilities: { autoUpdate: true } });
    await render(newerServer);

    expect(byId('update-now')).not.toBeNull();
    expect(byId('update-get')).toBeNull();

    await click('update-now');
    expect(updater.calls.map((c) => c.method)).toContain('checkForUpdates');
    expect(byId('update-state')!.textContent).toContain('Downloading 9.9.9');

    await act(async () => { updater.fire('onDownloadProgress', { percent: 42 }); });
    expect(byId('update-state')!.textContent).toContain('42%');

    await act(async () => { updater.fire('onUpdateDownloaded', { version: '9.9.9' }); });
    expect(byId('update-restart')).not.toBeNull();
    expect(byId('update-state')!.textContent).toContain('Restart to finish');

    await click('update-restart');
    expect(updater.calls.map((c) => c.method)).toContain('installUpdate');
  });

  it('says plainly that this is already the newest release when the check finds nothing', async () => {
    const updater = fakeUpdater({ canSelfUpdate: true, check: { status: 'none', version: '0.7.0' } });
    installBridge({ updater, capabilities: { autoUpdate: true } });
    await render(newerServer);

    await click('update-now');
    expect(byId('update-state')!.textContent).toBe(
      'You already have the newest release (v0.7.0). The server is what has to be updated.',
    );
    // The button stays: a release may appear later.
    expect(byId('update-now')).not.toBeNull();
  });

  it('shows the error sentence when the check fails, and lets the person try again', async () => {
    const updater = fakeUpdater({ canSelfUpdate: true, check: new Error('no route to host') });
    installBridge({ updater, capabilities: { autoUpdate: true } });
    await render(newerServer);

    await click('update-now');
    expect(byId('update-state')!.textContent).toBe('Could not check for updates: no route to host');
    expect((byId('update-now') as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers the release page instead when the install cannot update itself (a .deb)', async () => {
    const openExternal = vi.fn(async () => {});
    const updater = fakeUpdater({ canSelfUpdate: false });
    installBridge({ updater, capabilities: { autoUpdate: true }, openExternal });
    await render(newerServer);

    expect(byId('update-now')).toBeNull();
    expect(byId('update-get')).not.toBeNull();
    expect(byId('update-note')!.textContent).toContain('cannot update itself');

    await click('update-get');
    expect(openExternal).toHaveBeenCalledWith('https://github.com/Khoality-dev/KurisuAssistant/releases/latest');
    expect(updater.calls.map((c) => c.method)).not.toContain('checkForUpdates');
  });

  it('offers the release page on a host with no updater at all (the web build)', async () => {
    const openExternal = vi.fn(async () => {});
    installBridge({ openExternal });
    await render(newerServer);

    expect(byId('update-get')).not.toBeNull();
    expect(byId('update-note')!.textContent).toContain('This build cannot update itself');
    await click('update-get');
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('offers nothing when the server is the side behind', async () => {
    installBridge({ updater: fakeUpdater({ canSelfUpdate: true }), capabilities: { autoUpdate: true } });
    await render(olderServer);

    expect(byId('update-offer')).toBeNull();
    expect(container.textContent).toContain('Ask the operator to update the server.');
  });

  it('still offers the update when the server refused without saying which protocol it speaks', async () => {
    installBridge({ updater: fakeUpdater({ canSelfUpdate: true }), capabilities: { autoUpdate: true } });
    await render({ backend_version: null, wire_protocol: null });

    expect(byId('update-now')).not.toBeNull();
  });
});

describe('describeUpdateState', () => {
  it('has a sentence for every resting state and none for idle', () => {
    expect(describeUpdateState({ status: 'idle' }, '0.7.0')).toBeNull();
    expect(describeUpdateState({ status: 'checking' }, '0.7.0')).toBe('Checking for a newer release…');
    expect(describeUpdateState({ status: 'available', version: '1.0.0' }, '0.7.0')).toBe('Version 1.0.0 is available.');
    expect(describeUpdateState({ status: 'downloading', version: null, percent: 7.6 }, '0.7.0')).toBe('Downloading the update… 8%');
    expect(describeUpdateState({ status: 'ready', version: '1.0.0' }, '0.7.0')).toBe('Version 1.0.0 is downloaded. Restart to finish.');
    expect(describeUpdateState({ status: 'none', version: null }, '0.7.0')).toBe(
      'No newer release was found. The server is what has to be updated.',
    );
    expect(describeUpdateState({ status: 'unavailable', reason: 'why' }, '0.7.0')).toBe('why');
    expect(describeUpdateState({ status: 'error', message: 'boom' }, '0.7.0')).toBe('boom');
  });
});
