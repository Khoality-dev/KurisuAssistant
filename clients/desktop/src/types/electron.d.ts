export interface ElectronAPI {
  platform: string;
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}

export {};
