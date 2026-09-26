import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  // Baked in by vite.config.ts from package.json, so an unpackaged run (the
  // e2e suite) reports the same number an installed build does (#257).
  appVersion: __APP_VERSION__,
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
    // The gate's "Update now" (#264): ask now instead of waiting for the
    // startup check, and learn first whether this install can update itself.
    canSelfUpdate: () => ipcRenderer.invoke('updater:can-self-update'),
    checkForUpdates: () => ipcRenderer.invoke('updater:check'),
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
    callTool: (toolName: string, args: Record<string, unknown>) =>
      ipcRenderer.invoke('host-tools:call-tool', toolName, args),
    isHostTool: (name: string) => ipcRenderer.invoke('host-tools:is-host-tool', name),
    getAllowedPaths: () => ipcRenderer.invoke('host-tools:get-allowed-paths'),
    setAllowedPaths: (paths: string[]) =>
      ipcRenderer.invoke('host-tools:set-allowed-paths', paths),
    getToolPolicies: () => ipcRenderer.invoke('host-tools:get-tool-policies'),
    removeToolPolicy: (toolName: string) =>
      ipcRenderer.invoke('host-tools:remove-tool-policy', toolName),
    getSessionApprovals: () => ipcRenderer.invoke('host-tools:get-session-approvals'),
    clearSessionApprovals: () => ipcRenderer.invoke('host-tools:clear-session-approvals'),
    onDiffReview: (cb: (data: { reviewId: string; filePath: string; fileName: string; originalContent: string; modifiedContent: string }) => void) => {
      const handler = (_event: any, data: any) => cb(data);
      ipcRenderer.on('host-tools:diff-review', handler);
      return () => ipcRenderer.removeListener('host-tools:diff-review', handler);
    },
    sendDiffResult: (reviewId: string, accepted: boolean, approvalLevel?: string) =>
      ipcRenderer.send('host-tools:diff-result', reviewId, accepted, approvalLevel),
    onDiffClear: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('host-tools:diff-clear', handler);
      return () => ipcRenderer.removeListener('host-tools:diff-clear', handler);
    },
    onApprovalRequest: (cb: (data: { approvalId: string; ruleKey: string; detail: string; options: string[] }) => void) => {
      const handler = (_event: any, data: any) => cb(data);
      ipcRenderer.on('host-tool-approval-request', handler);
      return () => ipcRenderer.removeListener('host-tool-approval-request', handler);
    },
    sendApprovalResponse: (approvalId: string, decision: string) =>
      ipcRenderer.send('host-tool-approval-response', approvalId, decision),
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
    searchNames: (query: string, dirPath: string, options?: { caseSensitive?: boolean; wholeWord?: boolean }) =>
      ipcRenderer.invoke('explorer:search-names', query, dirPath, options),
    searchContentStart: (query: string, dirPath: string, options?: { caseSensitive?: boolean; wholeWord?: boolean; glob?: string }) =>
      ipcRenderer.invoke('explorer:search-content-start', query, dirPath, options),
    searchContentCancel: () =>
      ipcRenderer.invoke('explorer:search-content-cancel'),
    onSearchContentBatch: (cb: (matches: Array<{ path: string; line: number; snippet: string }>) => void) => {
      const handler = (_event: any, matches: any) => cb(matches);
      ipcRenderer.on('explorer:search-content-batch', handler);
      return () => ipcRenderer.removeListener('explorer:search-content-batch', handler);
    },
    onSearchContentDone: (cb: (error: string | null) => void) => {
      const handler = (_event: any, error: any) => cb(error);
      ipcRenderer.on('explorer:search-content-done', handler);
      return () => ipcRenderer.removeListener('explorer:search-content-done', handler);
    },
  },

  // Kurisu Drive transfers. Streamed in the main process, because a drive file
  // can be gigabytes and the renderer would have to hold the whole thing.
  drive: {
    /**
     * The real path of a dragged-in file.
     *
     * `File.path` was removed in Electron 32; `webUtils.getPathForFile` is its
     * replacement and has to be called here, in preload, not in the renderer.
     * The fallback keeps this working on the older Electron a stale
     * `node_modules` may still hold. Without a path there is nothing for the
     * main process to stream, so a drop would silently do nothing.
     */
    pathForFile: (file: File): string => {
      if (typeof webUtils?.getPathForFile === 'function') return webUtils.getPathForFile(file);
      return (file as File & { path?: string }).path ?? '';
    },
    pickFiles: () =>
      ipcRenderer.invoke('drive:pick-files'),
    upload: (id: string, req: { baseUrl: string; token: string; localPath: string; parentId: number | null; name: string; overwrite?: boolean }) =>
      ipcRenderer.invoke('drive:upload', id, req),
    download: (id: string, req: { baseUrl: string; token: string; nodeId: number; fileName: string }) =>
      ipcRenderer.invoke('drive:download', id, req),
    cancel: (id: string) =>
      ipcRenderer.invoke('drive:cancel', id),
    onTransferProgress: (cb: (progress: { id: string; loaded: number; total: number | null }) => void) => {
      const handler = (_event: any, progress: any) => cb(progress);
      ipcRenderer.on('drive:transfer-progress', handler);
      return () => ipcRenderer.removeListener('drive:transfer-progress', handler);
    },
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
    getPlaywrightAutostart: () => ipcRenderer.invoke('mcp:get-playwright-autostart'),
    setPlaywrightAutostart: (enabled: boolean) =>
      ipcRenderer.invoke('mcp:set-playwright-autostart', enabled),
    getApprovedSpawns: () => ipcRenderer.invoke('mcp:get-approved-spawns'),
    revokeApprovedSpawn: (commandLine: string) =>
      ipcRenderer.invoke('mcp:revoke-approved-spawn', commandLine),
  },

  // Session tokens, kept in the OS keychain by the main process rather than in
  // localStorage. The renderer holds them in memory for the life of a window.
  credentials: {
    isSecure: () => ipcRenderer.invoke('credentials:is-secure'),
    read: () => ipcRenderer.invoke('credentials:read'),
    write: (credentials: { accessToken: string | null; refreshToken: string | null }) =>
      ipcRenderer.invoke('credentials:write', credentials),
    clear: () => ipcRenderer.invoke('credentials:clear'),
  },

  // The app's own MCP endpoint — the one external clients connect *to*.
  mcpServer: {
    getInfo: () => ipcRenderer.invoke('mcp-server:get-info'),
    rotateToken: () => ipcRenderer.invoke('mcp-server:rotate-token'),
  },

  characterWindow: {
    open: () => ipcRenderer.invoke('character:open-window'),
    close: () => ipcRenderer.invoke('character:close-window'),

    // The session, pushed by the main renderer: the access token only, never
    // the refresh token (#237). `character:session-request` is the other way —
    // the character window's token was refused and it wants a fresh one.
    sendSession: (data: { accessToken: string | null }) =>
      ipcRenderer.send('character:session', data),
    onSession: (cb: (data: { accessToken: string | null }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { accessToken: string | null }) => cb(data);
      ipcRenderer.on('character:session', handler);
      return () => { ipcRenderer.removeListener('character:session', handler); };
    },
    requestSession: () => ipcRenderer.send('character:session-request'),
    onSessionRequest: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('character:session-request', handler);
      return () => { ipcRenderer.removeListener('character:session-request', handler); };
    },

    // The speech feed: one message per spoken sentence (its RMS curve and the
    // moment it began) and a position sync a few times a second while it
    // plays. The window clocks the mouth itself, so nothing crosses at frame
    // rate and hiding the main window to the tray cannot stall it (#238).
    sendSpeech: (segment: any) => ipcRenderer.send('character:speech', segment),
    onSpeech: (cb: (segment: any) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, segment: any) => cb(segment);
      ipcRenderer.on('character:speech', handler);
      return () => { ipcRenderer.removeListener('character:speech', handler); };
    },
    sendSpeechSync: (sync: { positionMs: number; at: number }) => ipcRenderer.send('character:speech-sync', sync),
    onSpeechSync: (cb: (sync: { positionMs: number; at: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sync: { positionMs: number; at: number }) => cb(sync);
      ipcRenderer.on('character:speech-sync', handler);
      return () => { ipcRenderer.removeListener('character:speech-sync', handler); };
    },
    // `emotion` is a feeling to show outside speech (#244); the relay carries it as-is.
    sendFeed: (data: { isThinking: boolean; emotion?: any }) => ipcRenderer.send('character:feed', data),
    onFeed: (cb: (data: { isThinking: boolean; emotion?: any }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { isThinking: boolean; emotion?: any }) => cb(data);
      ipcRenderer.on('character:feed', handler);
      return () => { ipcRenderer.removeListener('character:feed', handler); };
    },
    sendPersonasUpdate: (data: { personas: Array<{ id: number; name: string; avatarUuid: string | null; character: any }>; activePersonaId: number | null }) =>
      ipcRenderer.send('character:personas-update', data),
    onPersonasUpdate: (cb: (data: { personas: Array<{ id: number; name: string; avatarUuid: string | null; character: any }>; activePersonaId: number | null }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: any) => cb(data);
      ipcRenderer.on('character:personas-update', handler);
      return () => { ipcRenderer.removeListener('character:personas-update', handler); };
    },
    onWindowClosed: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('character:window-closed', handler);
      return () => { ipcRenderer.removeListener('character:window-closed', handler); };
    },

    sendGestureUpdate: (data: { gestures: string[]; seq: number }) =>
      ipcRenderer.send('character:gesture-update', data),
    onGestureUpdate: (cb: (data: { gestures: string[]; seq: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { gestures: string[]; seq: number }) => cb(data);
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

    sendSubtitle: (data: { text: string; isUser: boolean; duration?: number }) =>
      ipcRenderer.send('character:subtitle', data),
    onSubtitle: (cb: (data: { text: string; isUser: boolean; duration?: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { text: string; isUser: boolean; duration?: number }) => cb(data);
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
