import { storage } from './utils/storage';
import { resolveBridge } from '@kurisu/platform';

export const config = {
  get apiBaseUrl(): string {
    // A build the backend served is already at the right address, and any other
    // would be a second origin: new CORS, a second certificate to accept, and a
    // WebSocket whose failure the browser cannot show the user.
    if (!resolveBridge().capabilities.configurableServer) return window.location.origin;
    return storage.getBackendUrl();
  },
};
