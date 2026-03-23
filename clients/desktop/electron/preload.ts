import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
  openPath: (filePath: string) => ipcRenderer.invoke('shell:open-path', filePath),

  updater: {
    onUpdateAvailable: (cb: (info: { version: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, info: { version: string }) => cb(info);
      ipcRenderer.on('updater:update-available', handler);
      return () => { ipcRenderer.removeListener('updater:update-available', handler); };
    },
    onDownloadProgress: (cb: (progress: { percent: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: { percent: number }) => cb(progress);
      ipcRenderer.on('updater:download-progress', handler);
      return () => { ipcRenderer.removeListener('updater:download-progress', handler); };
    },
    onUpdateDownloaded: (cb: (info: { version: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, info: { version: string }) => cb(info);
      ipcRenderer.on('updater:update-downloaded', handler);
      return () => { ipcRenderer.removeListener('updater:update-downloaded', handler); };
    },
    installUpdate: () => ipcRenderer.send('updater:install'),
  },

  extensions: {
    checkHealth: (url: string) => ipcRenderer.invoke('extensions:check-health', url),
    checkInstalled: (appName: string) => ipcRenderer.invoke('extensions:check-installed', appName),
    launchApp: (appName: string) => ipcRenderer.invoke('extensions:launch-app', appName),
    downloadAndInstall: (url: string) => ipcRenderer.invoke('extensions:download-install', url),
    downloadPortable: (url: string, appName: string) => ipcRenderer.invoke('extensions:download-portable', url, appName),
    uninstall: (appName: string) => ipcRenderer.invoke('extensions:uninstall', appName),
    onDownloadProgress: (cb: (progress: { percent: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: { percent: number }) => cb(progress);
      ipcRenderer.on('extensions:download-progress', handler);
      return () => { ipcRenderer.removeListener('extensions:download-progress', handler); };
    },
  },

  appTools: {
    listTools: () => ipcRenderer.invoke('app-tools:list-tools'),
    callTool: (name: string, args: Record<string, unknown>) =>
      ipcRenderer.invoke('app-tools:call-tool', name, args),
    isAppTool: (name: string) => ipcRenderer.invoke('app-tools:is-app-tool', name),
    onExecute: (cb: (data: { callId: number; name: string; args: Record<string, unknown> }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { callId: number; name: string; args: Record<string, unknown> }) => cb(data);
      ipcRenderer.on('app-tools:execute', handler);
      return () => { ipcRenderer.removeListener('app-tools:execute', handler); };
    },
    sendResult: (callId: number, result: { content: string; isError: boolean }) =>
      ipcRenderer.send('app-tools:result', callId, result),
  },

  hostTools: {
    listTools: () => ipcRenderer.invoke('host-tools:list-tools'),
    callTool: (toolName: string, args: Record<string, unknown>, agentId: number) =>
      ipcRenderer.invoke('host-tools:call-tool', toolName, args, agentId),
    isHostTool: (name: string) => ipcRenderer.invoke('host-tools:is-host-tool', name),
    getAllowedPaths: (agentId: number) => ipcRenderer.invoke('host-tools:get-allowed-paths', agentId),
    setAllowedPaths: (agentId: number, paths: string[]) =>
      ipcRenderer.invoke('host-tools:set-allowed-paths', agentId, paths),
  },

  explorer: {
    listDirectory: (dirPath: string) =>
      ipcRenderer.invoke('explorer:list-directory', dirPath),
    readFile: (filePath: string) =>
      ipcRenderer.invoke('explorer:read-file', filePath),
    writeFile: (filePath: string, content: string) =>
      ipcRenderer.invoke('explorer:write-file', filePath, content),
    isBinary: (filePath: string) => ipcRenderer.invoke('explorer:is-binary', filePath),
    createFile: (filePath: string) => ipcRenderer.invoke('explorer:create-file', filePath),
    createFolder: (dirPath: string) => ipcRenderer.invoke('explorer:create-folder', dirPath),
    rename: (oldPath: string, newPath: string) => ipcRenderer.invoke('explorer:rename', oldPath, newPath),
    delete: (targetPath: string) => ipcRenderer.invoke('explorer:delete', targetPath),
    copy: (srcPath: string, destPath: string) => ipcRenderer.invoke('explorer:copy', srcPath, destPath),
    hasVSCode: () => ipcRenderer.invoke('explorer:has-vscode'),
    openInVSCode: (filePath: string) => ipcRenderer.invoke('explorer:open-in-vscode', filePath),
  },

  onMCPToolsChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('mcp:tools-changed', handler);
    return () => { ipcRenderer.removeListener('mcp:tools-changed', handler); };
  },

  mcp: {
    startServers: (configs: Array<{ name: string; transport_type: string; url?: string; command?: string; args?: string[]; env?: Record<string, string> }>) =>
      ipcRenderer.invoke('mcp:start-servers', configs),
    startServer: (config: { name: string; transport_type: string; url?: string; command?: string; args?: string[]; env?: Record<string, string> }) =>
      ipcRenderer.invoke('mcp:start-server', config),
    isServerRunning: (name: string) => ipcRenderer.invoke('mcp:is-server-running', name),
    stopServers: () => ipcRenderer.invoke('mcp:stop-servers'),
    listTools: () => ipcRenderer.invoke('mcp:list-tools'),
    listToolsByServer: () => ipcRenderer.invoke('mcp:list-tools-by-server'),
    callTool: (toolName: string, args: Record<string, unknown>) =>
      ipcRenderer.invoke('mcp:call-tool', toolName, args),
  },

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

    sendFaceUpdate: (data: { faces: string[] }) =>
      ipcRenderer.send('character:face-update', data),
    onFaceUpdate: (cb: (data: { faces: string[] }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { faces: string[] }) => cb(data);
      ipcRenderer.on('character:face-update', handler);
      return () => { ipcRenderer.removeListener('character:face-update', handler); };
    },

    sendSubtitle: (data: { text: string; isUser: boolean }) =>
      ipcRenderer.send('character:subtitle', data),
    onSubtitle: (cb: (data: { text: string; isUser: boolean }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { text: string; isUser: boolean }) => cb(data);
      ipcRenderer.on('character:subtitle', handler);
      return () => { ipcRenderer.removeListener('character:subtitle', handler); };
    },

    signalReady: () => ipcRenderer.send('character:ready'),
    onCharacterReady: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('character:ready', handler);
      return () => { ipcRenderer.removeListener('character:ready', handler); };
    },
  },
});
