const path = require('node:path');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), `desktop-pet-trtc-smoke-${process.pid}`));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, '..', 'src', 'main', 'control-preload.js'),
    },
  });
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    process.stderr.write(`preload-error ${preloadPath}: ${error?.stack || error}\n`);
  });
  win.webContents.on('console-message', (_event, level, message) => {
    process.stderr.write(`renderer-console ${level}: ${message}\n`);
  });
  await win.loadFile(path.join(__dirname, '..', 'dist', 'control', 'index.html'));
  const shape = await win.webContents.executeJavaScript('({ hasBridge: !!window.desktopPetControl, hasTrtc: !!window.desktopPetControl?.trtc })');
  process.stdout.write(`${JSON.stringify(shape)}\n`);
  const result = await win.webContents.executeJavaScript('window.desktopPetControl.trtc.isAvailable()');
  process.stdout.write(`${JSON.stringify(result)}\n`);
  win.destroy();
  app.exit(result?.ok ? 0 : 1);
}).catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  app.exit(1);
});
