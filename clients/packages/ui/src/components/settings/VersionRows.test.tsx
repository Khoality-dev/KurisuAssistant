/**
 * The version rows say which release the app and the backend are, and when
 * they are not the same one (#257).
 */
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installBridge, resetBridge } from '@kurisu/platform/testing';
import { WIRE_PROTOCOL, type ServerVersionInfo } from '@kurisu/models';
import { VersionRows } from './VersionRows';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function render(fetchServerVersion: () => Promise<ServerVersionInfo>) {
  await act(async () => {
    root.render(<VersionRows fetchServerVersion={fetchServerVersion} />);
  });
  // Let the fetch settle and the state land.
  await act(async () => { await Promise.resolve(); });
}

const text = (testId: string) => container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;

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

describe('VersionRows', () => {
  it('shows the app, the backend and both protocol numbers', async () => {
    installBridge({ appVersion: '0.7.0' });
    await render(async () => ({ backend_version: '0.7.0', wire_protocol: WIRE_PROTOCOL }));

    expect(text('version-row-app')).toBe('App: v0.7.0');
    expect(text('version-row-backend')).toBe('Backend: v0.7.0');
    expect(text('version-row-protocol')).toBe(`Protocol: ${WIRE_PROTOCOL} (backend ${WIRE_PROTOCOL})`);
    expect(text('version-mismatch')).toBeNull();
  });

  it('says plainly when the app and the backend are different releases', async () => {
    installBridge({ appVersion: '0.7.0' });
    await render(async () => ({ backend_version: '0.6.0', wire_protocol: 6 }));

    expect(text('version-mismatch')).toBe(
      'This app is v0.7.0; the backend is v0.6.0 — update whichever is behind.',
    );
  });

  it('reads "unknown" when the backend cannot be reached, and does not call that a mismatch', async () => {
    installBridge({ appVersion: '0.7.0' });
    await render(async () => { throw new Error('ECONNREFUSED'); });

    expect(text('version-row-backend')).toBe('Backend: unknown');
    expect(text('version-row-protocol')).toBe(`Protocol: ${WIRE_PROTOCOL}`);
    expect(text('version-mismatch')).toBeNull();
  });

  it('has no app row on a host without a version of its own', async () => {
    installBridge({ appVersion: null });
    await render(async () => ({ backend_version: '0.7.0', wire_protocol: WIRE_PROTOCOL }));

    expect(text('version-row-app')).toBeNull();
    expect(text('version-row-backend')).toBe('Backend: v0.7.0');
    expect(text('version-mismatch')).toBeNull();
  });
});
