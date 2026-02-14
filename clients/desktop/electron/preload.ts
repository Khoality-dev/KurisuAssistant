import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,

  characterWindow: {
    open: () => ipcRenderer.invoke('character:open-window'),
    close: () => ipcRenderer.invoke('character:close-window'),

    sendAmplitude: (data: { amplitude: number; isPlaying: boolean; isThinking: boolean }) =>
      ipcRenderer.send('character:amplitude', data),
    sendAgentsUpdate: (data: { agents: Array<{ id: number; name: string; poseTree: any }>; activeAgentId: number | null }) =>
      ipcRenderer.send('character:agents-update', data),

    onAmplitude: (cb: (data: { amplitude: number; isPlaying: boolean; isThinking: boolean }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { amplitude: number; isPlaying: boolean; isThinking: boolean }) => cb(data);
      ipcRenderer.on('character:amplitude', handler);
      return () => { ipcRenderer.removeListener('character:amplitude', handler); };
    },
    onAgentsUpdate: (cb: (data: { agents: Array<{ id: number; name: string; poseTree: any }>; activeAgentId: number | null }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => cb(data);
      ipcRenderer.on('character:agents-update', handler);
      return () => { ipcRenderer.removeListener('character:agents-update', handler); };
    },
    onWindowClosed: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('character:window-closed', handler);
      return () => { ipcRenderer.removeListener('character:window-closed', handler); };
    },

    sendGestureUpdate: (data: { gestures: string[] }) =>
      ipcRenderer.send('character:gesture-update', data),
    onGestureUpdate: (cb: (data: { gestures: string[] }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { gestures: string[] }) => cb(data);
      ipcRenderer.on('character:gesture-update', handler);
      return () => { ipcRenderer.removeListener('character:gesture-update', handler); };
    },

    signalReady: () => ipcRenderer.send('character:ready'),
    onCharacterReady: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('character:ready', handler);
      return () => { ipcRenderer.removeListener('character:ready', handler); };
    },
  },
});
