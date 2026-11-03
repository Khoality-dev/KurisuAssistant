import { useEffect } from 'react';
import { apiClient, storage } from '@amadeus/api';
import { resolveBridge } from '@amadeus/platform';
import { mirrorCharacterFeed } from './characterBridgeSync';

/**
 * Mirror the character feed to the second window while it is open, and answer
 * its handshake. One instance, wherever the window's open/closed state is
 * owned (`ChatPanel`); on a host without a character window it does nothing.
 */
export function useCharacterBridgeSync(): void {
  useEffect(() => {
    const api = resolveBridge().characterWindow;
    if (!api) return;
    return mirrorCharacterFeed(api, {
      getToken: () => storage.getToken(),
      refresh: () => apiClient.tryRefresh(),
    });
  }, []);
}
