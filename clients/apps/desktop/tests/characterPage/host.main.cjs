// A bare Electron host for the Android character page (#245): one window on
// the URL the spec serves the committed page at, and nothing else — no
// preload, no bridge, the way a WebView holds it.
const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 360,
    height: 480,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(process.env.KURISU_PAGE_URL);
});
app.on('window-all-closed', () => app.quit());
