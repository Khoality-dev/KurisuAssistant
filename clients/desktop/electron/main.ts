import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'path';
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

// --- App Lifecycle ---

// Accept self-signed certificates (for direct HTTPS connections to backend)
app.on('certificate-error', (event, _webContents, _url, _error, _certificate, callback) => {
  event.preventDefault();
  callback(true);
});

app.whenReady().then(() => {
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
