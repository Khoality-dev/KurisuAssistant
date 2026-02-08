import { contextBridge } from 'electron';

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electron', {
  // Add any electron-specific APIs you need here
  platform: process.platform,
});
