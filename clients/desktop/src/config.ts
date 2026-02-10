import { storage } from './utils/storage';

export const config = {
  get apiBaseUrl(): string {
    return storage.getBackendUrl();
  },
};
