import { app, BrowserWindow, ipcMain, net, protocol, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import https from 'https';
import http from 'http';
import { spawn } from 'child_process';
import { autoUpdater } from 'electron-updater';

// Set custom cache path to avoid permission issues on Windows
app.setPath('userData', path.join(app.getPath('appData'), 'kurisu-assistant'));

let mainWindow: BrowserWindow | null = null;
let characterWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    frame: true,
    titleBarStyle: 'default',
  });

  // Load the app
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Close character window when main window closes
    if (characterWindow && !characterWindow.isDestroyed()) {
      characterWindow.close();
    }
  });
}

// --- Character Window ---

function createCharacterWindow() {
  if (characterWindow && !characterWindow.isDestroyed()) {
    characterWindow.focus();
    return;
  }

  characterWindow = new BrowserWindow({
    width: 512,
    height: 768,
    minWidth: 256,
    minHeight: 384,
    resizable: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    frame: false,
  });

  characterWindow.setAspectRatio(2 / 3);

  if (process.env.VITE_DEV_SERVER_URL) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL);
    url.searchParams.set('window', 'character');
    characterWindow.loadURL(url.toString());

  } else {
    characterWindow.loadFile(path.join(__dirname, '../dist/index.html'), {
      search: 'window=character',
    });
  }

  characterWindow.on('closed', () => {
    characterWindow = null;
    // Notify main window that character window was closed
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('character:window-closed');
    }
  });
}

// Open external URLs in system browser
ipcMain.handle('shell:open-external', (_event, url: string) => {
  return shell.openExternal(url);
});

// IPC handlers for character window lifecycle
ipcMain.handle('character:open-window', () => {
  createCharacterWindow();
});

ipcMain.handle('character:close-window', () => {
  if (characterWindow && !characterWindow.isDestroyed()) {
    characterWindow.close();
  }
});

// IPC relay: main renderer → character renderer
ipcMain.on('character:amplitude', (_event, data) => {
  if (characterWindow && !characterWindow.isDestroyed()) {
    characterWindow.webContents.send('character:amplitude', data);
  }
});

ipcMain.on('character:agents-update', (_event, data) => {
  if (characterWindow && !characterWindow.isDestroyed()) {
    characterWindow.webContents.send('character:agents-update', data);
  }
});

// IPC relay: character renderer → main renderer (ready signal)
ipcMain.on('character:ready', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('character:ready');
  }
});

// IPC: install update and restart
ipcMain.on('updater:install', () => {
  autoUpdater.quitAndInstall();
});

// IPC relay: gesture updates from main renderer → character renderer
ipcMain.on('character:gesture-update', (_event, data) => {
  if (characterWindow && !characterWindow.isDestroyed()) {
    characterWindow.webContents.send('character:gesture-update', data);
  }
});

// IPC relay: face updates from main renderer → character renderer
ipcMain.on('character:face-update', (_event, data) => {
  if (characterWindow && !characterWindow.isDestroyed()) {
    characterWindow.webContents.send('character:face-update', data);
  }
});

// IPC relay: subtitle from main renderer → character renderer
ipcMain.on('character:subtitle', (_event, data) => {
  if (characterWindow && !characterWindow.isDestroyed()) {
    characterWindow.webContents.send('character:subtitle', data);
  }
});

// --- Extensions ---

function getExtensionExePath(appName: string): string {
  const localAppData = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local');
  if (appName === 'maestro') {
    return path.join(localAppData, 'Programs', 'Maestro', 'Maestro.exe');
  }
  throw new Error(`Unknown extension: ${appName}`);
}

function downloadFile(url: string, destPath: string, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const doRequest = (requestUrl: string, redirectCount: number) => {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'));
        return;
      }
      const lib = requestUrl.startsWith('https') ? https : http;
      const req = lib.get(requestUrl, { headers: { 'User-Agent': 'KurisuAssistant' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const location = res.headers.location;
          if (!location) { reject(new Error('Redirect without location')); return; }
          doRequest(location, redirectCount + 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;
        const file = fs.createWriteStream(destPath);
        res.on('data', (chunk: Buffer) => {
          downloadedBytes += chunk.length;
          if (totalBytes > 0) {
            onProgress(Math.round((downloadedBytes / totalBytes) * 100));
          }
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
      });
      req.on('error', reject);
    };
    doRequest(url, 0);
  });
}

ipcMain.handle('extensions:check-health', (_event, url: string) => {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
});

ipcMain.handle('extensions:check-installed', (_event, appName: string) => {
  const exePath = getExtensionExePath(appName);
  return { installed: fs.existsSync(exePath), path: exePath };
});

ipcMain.handle('extensions:launch-app', (_event, appName: string) => {
  const exePath = getExtensionExePath(appName);
  if (!fs.existsSync(exePath)) throw new Error('Application not found');
  const child = spawn(exePath, [], { detached: true, stdio: 'ignore' });
  child.unref();
});

ipcMain.handle('extensions:download-install', async (_event, url: string) => {
  const tempDir = app.getPath('temp');
  const fileName = url.split('/').pop() || 'installer.exe';
  const destPath = path.join(tempDir, fileName);

  await downloadFile(url, destPath, (percent) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('extensions:download-progress', { percent });
    }
  });

  await shell.openPath(destPath);
});

// --- App Lifecycle ---

// Accept self-signed certificates (for direct HTTPS connections to backend)
app.on('certificate-error', (event, _webContents, _url, _error, _certificate, callback) => {
  event.preventDefault();
  callback(true);
});

app.whenReady().then(() => {
  // Intercept file:// requests to serve asar-unpacked files (WASM/ONNX can't load from asar)
  protocol.handle('file', (request) => {
    const url = decodeURIComponent(new URL(request.url).pathname);
    // On Windows, pathname starts with /C:/ — strip leading slash
    const filePath = process.platform === 'win32' ? url.slice(1) : url;
    // Redirect asar paths to asar.unpacked if the unpacked file exists
    if (filePath.includes('app.asar')) {
      const unpackedPath = filePath.replace('app.asar', 'app.asar.unpacked');
      if (fs.existsSync(unpackedPath)) {
        return net.fetch('file:///' + unpackedPath);
      }
    }
    return net.fetch('file:///' + filePath);
  });

  createWindow();

  // Auto-updater (no-op in dev mode — no update server configured)
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:update-available', { version: info.version });
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:download-progress', { percent: progress.percent });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:update-downloaded', { version: info.version });
    }
  });

  autoUpdater.checkForUpdatesAndNotify();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
