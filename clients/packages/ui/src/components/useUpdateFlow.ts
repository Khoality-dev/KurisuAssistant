/**
 * One state machine for replacing the app, shared by the startup dialog and
 * the update gate (#264).
 *
 * The startup check runs in the main process and only *reports* — available,
 * progress, downloaded — which is all `UpdateDialog` ever needed. The gate
 * needs to *ask* as well: a person standing on "Update required" should be
 * able to press one button and end up restarted into the new release, or be
 * told plainly that they already have the newest one, or that this install
 * cannot update itself. Both screens read the same state, so the two cannot
 * disagree about where the download is.
 */
import { useCallback, useEffect, useState } from 'react';
import { resolveBridge } from '@kurisu/platform';

export const RELEASES_URL = 'https://github.com/Khoality-dev/KurisuAssistant/releases/latest';

export type UpdateFlowState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; version: string | null; percent: number }
  | { status: 'ready'; version: string }
  /** The check ran and this is the newest release there is. */
  | { status: 'none'; version: string | null }
  /** This install cannot replace itself; the release page is the only offer. */
  | { status: 'unavailable'; reason: string }
  | { status: 'error'; message: string };

export interface UpdateFlow {
  state: UpdateFlowState;
  /** A host that offers an updater at all. `false` on the web build. */
  hasUpdater: boolean;
  /**
   * Whether this install can swap itself out, once the host has answered;
   * `null` until it has. A packaged NSIS or AppImage build says yes, a `.deb`
   * or an unpackaged run says no.
   */
  canSelfUpdate: boolean | null;
  /** Ask now. Resolves when the check has answered (the download, if any, reports on its own). */
  check: () => Promise<void>;
  /** Restart into the downloaded release. */
  install: () => void;
  /** Back to idle from a resting state (`none`, `error`, `available` before download). */
  dismiss: () => void;
}

export function useUpdateFlow(): UpdateFlow {
  const [state, setState] = useState<UpdateFlowState>({ status: 'idle' });
  const [canSelfUpdate, setCanSelfUpdate] = useState<boolean | null>(null);
  const updater = resolveBridge().updater;
  const hasUpdater = updater !== null;

  useEffect(() => {
    if (!updater) {
      setCanSelfUpdate(false);
      return;
    }
    let live = true;
    updater.canSelfUpdate().then(
      (answer) => { if (live) setCanSelfUpdate(answer); },
      () => { if (live) setCanSelfUpdate(false); },
    );
    const unsubs = [
      updater.onUpdateAvailable((info) => {
        setState({ status: 'available', version: info.version });
      }),
      updater.onDownloadProgress((p) => {
        setState((prev) => ({
          status: 'downloading',
          version: 'version' in prev ? prev.version : null,
          percent: p.percent,
        }));
      }),
      updater.onUpdateDownloaded((info) => {
        setState({ status: 'ready', version: info.version });
      }),
    ];
    return () => {
      live = false;
      unsubs.forEach((unsub) => unsub());
    };
  }, [updater]);

  const check = useCallback(async () => {
    if (!updater) {
      setState({ status: 'unavailable', reason: 'This build has no updater.' });
      return;
    }
    setState({ status: 'checking' });
    try {
      const result = await updater.checkForUpdates();
      switch (result.status) {
        case 'available':
          // The download is already under way; the progress events take over.
          setState({ status: 'downloading', version: result.version, percent: 0 });
          break;
        case 'none':
          setState({ status: 'none', version: result.version });
          break;
        case 'unavailable':
          setState({ status: 'unavailable', reason: result.reason });
          break;
      }
    } catch (error) {
      setState({ status: 'error', message: `Could not check for updates: ${(error as Error).message}` });
    }
  }, [updater]);

  const install = useCallback(() => {
    updater?.installUpdate();
  }, [updater]);

  const dismiss = useCallback(() => {
    setState((prev) => (prev.status === 'downloading' || prev.status === 'checking' ? prev : { status: 'idle' }));
  }, []);

  return { state, hasUpdater, canSelfUpdate, check, install, dismiss };
}
