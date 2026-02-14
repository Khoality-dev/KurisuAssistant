import { app, BrowserWindow, ipcMain } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';

// Set custom cache path to avoid permission issues on Windows
app.setPath('userData', path.join(app.getPath('appData'), 'kurisu-assistant'));

let mainWindow: BrowserWindow | null = null;
let characterWindow: BrowserWindow | null = null;
let ffmpegProcess: ChildProcess | null = null;

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
    resizable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    frame: false,
  });

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

// IPC relay: gesture updates from main renderer → character renderer
ipcMain.on('character:gesture-update', (_event, data) => {
  if (characterWindow && !characterWindow.isDestroyed()) {
    characterWindow.webContents.send('character:gesture-update', data);
  }
});

// --- Vision (ffmpeg webcam → RTSP) ---

ipcMain.handle('vision:start', (_event, webcamName: string, rtspUrl: string) => {
  // Kill existing ffmpeg process
  if (ffmpegProcess) {
    ffmpegProcess.kill('SIGTERM');
    ffmpegProcess = null;
  }

  // Strip browser-style suffixes like " (046d:0825)" from webcam label
  const dshowName = webcamName.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '');

  // Spawn ffmpeg to capture webcam and push to RTSP server via TCP
  const args = [
    '-f', 'dshow',
    '-rtbufsize', '100M',
    '-i', `video=${dshowName}`,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-rtsp_transport', 'tcp',
    '-f', 'rtsp',
    rtspUrl,
  ];

  ffmpegProcess = spawn('ffmpeg', args);

  ffmpegProcess.stderr?.on('data', (data: Buffer) => {
    console.log('[Vision] ffmpeg:', data.toString().trim());
  });

  ffmpegProcess.on('error', (error) => {
    console.error('[Vision] ffmpeg process error:', error);
    ffmpegProcess = null;
  });

  ffmpegProcess.on('close', () => {
    ffmpegProcess = null;
  });

  return { status: 'started' };
});

ipcMain.handle('vision:stop', () => {
  if (ffmpegProcess) {
    ffmpegProcess.kill('SIGTERM');
    ffmpegProcess = null;
  }
  return { status: 'stopped' };
});

ipcMain.handle('vision:list-webcams', async () => {
  // Use ffmpeg to list DirectShow devices on Windows
  return new Promise<string[]>((resolve) => {
    const proc = spawn('ffmpeg', ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);

    let stderr = '';
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', () => {
      const webcams: string[] = [];
      const lines = stderr.split('\n');
      let inVideoSection = false;
      for (const line of lines) {
        if (line.includes('DirectShow video devices')) {
          inVideoSection = true;
          continue;
        }
        if (line.includes('DirectShow audio devices')) {
          inVideoSection = false;
          continue;
        }
        if (inVideoSection) {
          const match = line.match(/"([^"]+)"/);
          if (match && !line.includes('Alternative name')) {
            webcams.push(match[1]);
          }
        }
      }
      resolve(webcams);
    });

    proc.on('error', () => {
      resolve([]);
    });
  });
});

// --- App Lifecycle ---

app.whenReady().then(() => {
  createWindow();

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
