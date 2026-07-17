const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, globalShortcut, desktopCapturer, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { randomUUID } = require('crypto');
const { shouldShowControlOnStartup } = require('./pairing-config');
const {
  appendDiagnostic,
  clampBoundsToWorkArea,
  clampScale,
  readDiagnosticLogs,
  redactDiagnosticValue,
} = require('./diagnostics');

const DEV_URL = 'http://localhost:5173';
const CONTROL_DEV_URL = 'http://localhost:5174';
const isDev = !app.isPackaged;
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {
  autoUpdater = null;
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.platform === 'win32') app.setAppUserModelId('com.deequoique.desktop-pet');

const TASKBAR_ICON = path.join(__dirname, 'assets', process.platform === 'win32' ? 'taskbar.ico' : 'taskbar.png');

// scale=1 的基准尺寸；实际窗口 = 基准 * scale。
// v1.4 起基准缩小为旧版的一半，保留已有 scale 档位与持久值语义。
const PET_W = 180;
const PET_H = 240;
const MIN_SCALE = 0.3;
const MAX_SCALE = 1.5;

const stateFile = () => path.join(app.getPath('userData'), 'pet-state.json');
const pairingFile = () => path.join(app.getPath('userData'), 'pairing.json');
const ttsCredentialsFile = () => path.join(app.getPath('userData'), 'tts-credentials.bin');
const diagnosticLogFile = () => path.join(app.getPath('userData'), 'logs', 'diagnostic.jsonl');

function diagnostic(event, payload = {}) {
  appendDiagnostic(diagnosticLogFile(), event, payload);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); }
  catch { return null; }
}
function saveState(state) {
  try { fs.writeFileSync(stateFile(), JSON.stringify(state)); } catch {}
}
// 合并写入：只更新传入的字段，保留其余（位置 / scale 互不覆盖）。
function patchState(patch) {
  const cur = loadState() || {};
  saveState({ ...cur, ...patch });
}

function currentScale() {
  const s = loadState();
  return clampScale(s && s.scale != null ? s.scale : 1, MIN_SCALE, MAX_SCALE);
}

function launchAtStartupEnabled() {
  if (!app.isPackaged) return false;
  try { return app.getLoginItemSettings().openAtLogin; }
  catch { return false; }
}

function setLaunchAtStartup(enabled) {
  if (!app.isPackaged) return false;
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
    });
    patchState({ launchAtStartupConfigured: true });
    return true;
  } catch (error) {
    console.warn('[startup] update failed:', error?.message || error);
    return false;
  }
}

function ensureDefaultLaunchAtStartup() {
  if (!app.isPackaged) return;
  const state = loadState() || {};
  if (state.launchAtStartupConfigured) return;
  setLaunchAtStartup(true);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function writeJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.warn('[config] write failed:', error?.message || error);
    return false;
  }
}

function loadRuntimeConfig() {
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, 'config', 'production.json'),
        path.join(path.dirname(process.execPath), 'config', 'production.json'),
      ]
    : [
        path.join(__dirname, '..', '..', 'config', 'production.json'),
      ];

  for (const file of candidates) {
    const config = readJson(file);
    if (config && typeof config === 'object') return config;
  }
  return {};
}

const runtimeConfig = loadRuntimeConfig();
const pairingConfig = readJson(pairingFile()) || {};

function configuredServerUrl() {
  return pairingConfig.serverUrl || runtimeConfig.serverUrl || process.env.PET_SERVER_URL || '';
}

function configuredRoomSecret() {
  return pairingConfig.roomSecret || process.env.PET_ROOM_SECRET || '';
}

function pairingSnapshot() {
  return {
    serverUrl: configuredServerUrl(),
    roomSecret: configuredRoomSecret(),
    deviceId: pairingConfig.deviceId || pairingConfig.participantId || '',
    deviceName: pairingConfig.deviceName || os.hostname(),
    memberId: pairingConfig.memberId || '',
  };
}

function ensureDeviceId() {
  if (!pairingConfig.deviceId) {
    pairingConfig.deviceId = pairingConfig.participantId || randomUUID();
    delete pairingConfig.participantId;
    writeJson(pairingFile(), pairingConfig);
  }
  return pairingConfig.deviceId;
}

function loadTtsApiKey() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return '';
    const encrypted = fs.readFileSync(ttsCredentialsFile());
    return safeStorage.decryptString(encrypted);
  } catch {
    return '';
  }
}

function saveTtsApiKey(apiKey) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'secure storage unavailable' };
    const value = String(apiKey || '').trim();
    if (!value) {
      try { fs.unlinkSync(ttsCredentialsFile()); } catch {}
      return { ok: true, configured: false };
    }
    fs.writeFileSync(ttsCredentialsFile(), safeStorage.encryptString(value));
    return { ok: true, configured: true };
  } catch (error) {
    return { ok: false, error: error?.message || 'secure storage write failed' };
  }
}

function defaultBottomRight() {
  const { workArea } = screen.getPrimaryDisplay();
  const [w, h] = win && !win.isDestroyed() ? win.getSize() : [PET_W, PET_H];
  return {
    x: workArea.x + workArea.width - w - 16,
    y: workArea.y + workArea.height - h - 16,
  };
}

let win = null;
let controlWin = null;
let tray = null;
let gameMode = false;
let petDragging = false;
let petDragOffset = { x: 0, y: 0 };
let updateState = {
  checking: false,
  available: false,
  downloaded: false,
  version: '',
  error: '',
};

function displaySnapshot(display) {
  if (!display) return null;
  return {
    id: display.id,
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
    rotation: display.rotation,
  };
}

function allDisplaySnapshots() {
  try { return screen.getAllDisplays().map(displaySnapshot); }
  catch { return []; }
}

function currentWindowSnapshot() {
  if (!win || win.isDestroyed()) return null;
  const bounds = win.getBounds();
  return {
    bounds,
    display: displaySnapshot(screen.getDisplayMatching(bounds)),
  };
}

function broadcastScaleChanged(scale) {
  for (const target of [win, controlWin]) {
    if (target && !target.isDestroyed()) target.webContents.send('pet:scale-changed', scale);
  }
}

function applyPetScale(rawScale, source = 'unknown') {
  if (!win || win.isDestroyed()) return { ok: false, error: 'pet_window_unavailable' };
  const requestedScale = Number(rawScale);
  const scale = clampScale(requestedScale, MIN_SCALE, MAX_SCALE);
  const before = win.getBounds();
  const display = screen.getDisplayMatching(before);
  const width = Math.round(PET_W * scale);
  const height = Math.round(PET_H * scale);
  const desired = clampBoundsToWorkArea({
    x: before.x + (before.width - width) / 2,
    y: before.y + before.height - height,
    width,
    height,
  }, display.workArea);

  win.setBounds(desired);
  const after = win.getBounds();
  const actualScale = Math.round(clampScale(after.width / PET_W, MIN_SCALE, MAX_SCALE) * 1000) / 1000;
  patchState({ x: after.x, y: after.y, scale: actualScale });
  diagnostic('pet-scale-applied', {
    source,
    requestedScale: Number.isFinite(requestedScale) ? requestedScale : String(rawScale),
    clampedScale: scale,
    actualScale,
    before,
    desired,
    after,
    display: displaySnapshot(display),
  });
  broadcastScaleChanged(actualScale);
  return { ok: true, scale: actualScale, bounds: after };
}

function diagnosticSnapshot() {
  return redactDiagnosticValue({
    generatedAt: new Date().toISOString(),
    app: {
      name: app.getName(),
      version: app.getVersion(),
      packaged: app.isPackaged,
    },
    runtime: {
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      osVersion: typeof os.version === 'function' ? os.version() : '',
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    displays: allDisplaySnapshots(),
    petWindow: currentWindowSnapshot(),
    petState: loadState(),
  });
}

async function exportDiagnostics(parentWindow = controlWin?.isVisible() ? controlWin : win) {
  try {
    const defaultName = `desktop-pet-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const result = await dialog.showSaveDialog(parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined, {
      title: 'Export Desktop Pet Diagnostics',
      defaultPath: path.join(app.getPath('documents'), defaultName),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) {
      diagnostic('diagnostics-export-canceled');
      return { ok: false, canceled: true };
    }
    const bundle = redactDiagnosticValue({
      ...diagnosticSnapshot(),
      logs: readDiagnosticLogs(diagnosticLogFile()),
    });
    fs.writeFileSync(result.filePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
    diagnostic('diagnostics-exported');
    return { ok: true, canceled: false, path: result.filePath };
  } catch (error) {
    diagnostic('diagnostics-export-failed', { error: error?.message || String(error) });
    return { ok: false, canceled: false, error: error?.message || 'export_failed' };
  }
}

function showUpdateMessage(type, message) {
  if (!win || win.isDestroyed()) return;
  dialog.showMessageBox(win, {
    type,
    title: 'Desktop Pet Update',
    message,
    buttons: ['OK'],
  }).catch(() => {});
}

function rebuildTrayMenu() {
  if (!tray) return;
  const updateLabel = updateState.checking
    ? 'Checking for Updates...'
    : updateState.downloaded
      ? `Install Update ${updateState.version || ''}`.trim()
      : 'Check for Updates';

  const menu = Menu.buildFromTemplate([
    {
      label: 'Open Control Panel',
      click: () => showControlWindow(),
    },
    { type: 'separator' },
    {
      label: 'Game Mode (mouse click-through)',
      type: 'checkbox',
      checked: gameMode,
      accelerator: 'Control+Alt+G',
      click: (item) => setGameMode(item.checked),
    },
    { type: 'separator' },
    {
      label: 'Launch at startup',
      type: 'checkbox',
      checked: launchAtStartupEnabled(),
      enabled: app.isPackaged,
      click: (item) => {
        if (!setLaunchAtStartup(item.checked)) item.checked = !item.checked;
        rebuildTrayMenu();
      },
    },
    { type: 'separator' },
    { label: 'Reset Position', click: () => {
        const p = defaultBottomRight();
        win?.setPosition(p.x, p.y);
        patchState({ x: p.x, y: p.y });
        diagnostic('pet-position-reset', { position: p, window: currentWindowSnapshot() });
      } },
    { label: 'Reset Pet Size', click: () => applyPetScale(1, 'tray-reset') },
    { label: 'Export Diagnostics...', click: () => { void exportDiagnostics(); } },
    { label: updateLabel, enabled: app.isPackaged && !!autoUpdater && !updateState.checking, click: () => {
        if (updateState.downloaded && autoUpdater) {
          autoUpdater.quitAndInstall(false, true);
          return;
        }
        checkForPetUpdates(true);
      } },
    { label: 'Reload', click: () => win?.reload() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function setGameMode(enabled) {
  gameMode = !!enabled;
  if (gameMode) petDragging = false;
  patchState({ gameMode });
  if (win && !win.isDestroyed()) {
    // Game mode is an unconditional lock: renderer hit-testing must not make
    // any part of the pet clickable while the user is playing. When leaving
    // game mode, start from pass-through until the next renderer hit-test.
    win.setIgnoreMouseEvents(true);
  }
  rebuildTrayMenu();
}

function checkForPetUpdates(manual = false) {
  if (!app.isPackaged || !autoUpdater || updateState.checking) return;
  updateState = { ...updateState, checking: true, error: '' };
  rebuildTrayMenu();
  autoUpdater.checkForUpdates().then((result) => {
    if (!result?.updateInfo && manual) showUpdateMessage('info', 'No update information was returned.');
  }).catch((error) => {
    const message = error?.message || String(error);
    updateState = { ...updateState, checking: false, error: message };
    rebuildTrayMenu();
    console.warn('[updater] check failed:', message);
    if (manual) showUpdateMessage('warning', `Update check failed: ${message}`);
  });
}

function setupAutoUpdater() {
  if (!app.isPackaged || !autoUpdater) return;

  autoUpdater.allowPrerelease = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    updateState = { ...updateState, checking: true, error: '' };
    rebuildTrayMenu();
  });
  autoUpdater.on('update-available', (info) => {
    updateState = {
      ...updateState,
      checking: false,
      available: true,
      downloaded: false,
      version: info?.version || '',
    };
    rebuildTrayMenu();
  });
  autoUpdater.on('update-not-available', () => {
    updateState = { ...updateState, checking: false, available: false, downloaded: false, version: '' };
    rebuildTrayMenu();
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateState = {
      ...updateState,
      checking: false,
      available: true,
      downloaded: true,
      version: info?.version || updateState.version,
    };
    rebuildTrayMenu();
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Desktop Pet Update',
      message: `Update ${updateState.version || ''} is ready.`,
      detail: 'Restart Desktop Pet now to install it?',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then((result) => {
      if (result.response === 0) autoUpdater.quitAndInstall(false, true);
    }).catch(() => {});
  });
  autoUpdater.on('error', (error) => {
    const message = error?.message || String(error);
    updateState = { ...updateState, checking: false, error: message };
    rebuildTrayMenu();
    console.warn('[updater] error:', message);
  });
}

function createWindow() {
  const saved = loadState();
  gameMode = !!saved?.gameMode;
  const scale = clampScale(saved && saved.scale != null ? saved.scale : 1, MIN_SCALE, MAX_SCALE);
  const w = Math.round(PET_W * scale);
  const h = Math.round(PET_H * scale);
  const hasPos = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y);
  // 无保存位置：按当前尺寸贴右下角。
  const fallbackPos = (() => {
    const { workArea } = screen.getPrimaryDisplay();
    return { x: workArea.x + workArea.width - w - 16, y: workArea.y + workArea.height - h - 16 };
  })();
  const pos = hasPos ? saved : fallbackPos;
  const initialDisplay = screen.getDisplayMatching({ x: pos.x, y: pos.y, width: w, height: h });
  const initialBounds = clampBoundsToWorkArea({ x: pos.x, y: pos.y, width: w, height: h }, initialDisplay.workArea);

  win = new BrowserWindow({
    width: initialBounds.width,
    height: initialBounds.height,
    x: initialBounds.x,
    y: initialBounds.y,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    focusable: true,
    backgroundColor: '#00000000',
    icon: TASKBAR_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 默认整窗穿透；渲染层 raycast 命中模型时再切换。
  // 注意：macOS 上 forward:true 不可靠，所以我们用主进程轮询 cursor，不依赖 OS 转发。
  win.setIgnoreMouseEvents(true);
  const reinforceTopmost = () => {
    if (!win || win.isDestroyed()) return;
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  };
  reinforceTopmost();
  win.setFullScreenable(false);

  // 部分无边框全屏游戏获得焦点时会重排顶层窗口；失焦后重新声明置顶层级。
  win.on('blur', () => setTimeout(reinforceTopmost, 100));

  if (isDev) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  diagnostic('pet-window-created', {
    savedState: saved,
    requestedScale: scale,
    initialBounds,
    actualBounds: win.getBounds(),
    display: displaySnapshot(initialDisplay),
  });
  win.webContents.on('did-finish-load', () => broadcastScaleChanged(currentScale()));
  win.webContents.on('render-process-gone', (_event, details) => {
    diagnostic('pet-render-process-gone', details);
  });
  win.on('unresponsive', () => diagnostic('pet-window-unresponsive', currentWindowSnapshot()));

  win.on('moved', () => {
    const [x, y] = win.getPosition();
    patchState({ x, y });
    diagnostic('pet-window-moved', currentWindowSnapshot());
  });
  win.on('resize', () => diagnostic('pet-window-resized', currentWindowSnapshot()));
}

function showControlWindow() {
  if (!controlWin || controlWin.isDestroyed()) createControlWindow();
  if (controlWin.webContents.isLoading()) {
    controlWin.once('ready-to-show', () => {
      controlWin.show();
      controlWin.focus();
    });
  } else {
    controlWin.show();
    controlWin.focus();
  }
}

function createControlWindow() {
  if (controlWin && !controlWin.isDestroyed()) return controlWin;
  controlWin = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 760,
    minHeight: 600,
    show: false,
    title: 'Desktop Pet Control Panel',
    icon: TASKBAR_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'control-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (isDev) controlWin.loadURL(CONTROL_DEV_URL);
  else controlWin.loadFile(path.join(__dirname, '../../dist/control/index.html'));
  controlWin.webContents.on('did-finish-load', () => broadcastScaleChanged(currentScale()));
  controlWin.webContents.on('render-process-gone', (_event, details) => {
    diagnostic('control-render-process-gone', details);
  });
  controlWin.on('unresponsive', () => diagnostic('control-window-unresponsive'));
  controlWin.on('close', (event) => {
    if (app.isQuiting) return;
    event.preventDefault();
    controlWin.hide();
  });
  return controlWin;
}

function createTray() {
  const img = nativeImage.createFromPath(TASKBAR_ICON);
  tray = new Tray(img);
  tray.setToolTip('Desktop Pet');
  tray.on('click', () => showControlWindow());
  rebuildTrayMenu();

  // Dock 右键菜单是 macOS 的备用入口，即使用户隐藏了菜单栏图标仍能打开控制面板。
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setMenu(Menu.buildFromTemplate([
      { label: 'Open Control Panel', click: () => showControlWindow() },
      { label: 'Toggle Game Mode', click: () => setGameMode(!gameMode) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]));
  }
}

// 渲染层根据 raycast 结果告诉我们鼠标是否在模型上
ipcMain.on('pet:set-clickable', (_e, clickable) => {
  if (!win || win.isDestroyed()) return;
  if (gameMode) {
    win.setIgnoreMouseEvents(true);
    return;
  }
  if (clickable || cursorInsidePetWindow) {
    win.setIgnoreMouseEvents(false);
  } else {
    win.setIgnoreMouseEvents(true);
  }
});

// 拖动支持：渲染层按住模型 → 主进程改变窗口位置
ipcMain.on('pet:drag', (_e, { dx, dy }) => {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  win.setPosition(x + dx, y + dy);
});

// 拖动由主进程按系统光标绝对位置驱动，避免透明窗口移动后 renderer
// 丢失 mousemove / movementX / movementY 导致拖动中断。
ipcMain.on('pet:drag-start', () => {
  if (!win || win.isDestroyed() || gameMode) return;
  const p = screen.getCursorScreenPoint();
  const [x, y] = win.getPosition();
  petDragOffset = { x: p.x - x, y: p.y - y };
  petDragging = true;
});
ipcMain.on('pet:drag-end', () => {
  petDragging = false;
});

// 远程 relocate：A 端发 corner → 主进程贴到对应角
function cornerPosition(corner) {
  const { workArea } = screen.getPrimaryDisplay();
  const margin = 16;
  // 用当前窗口实际尺寸算贴角，缩放后才不会偏。
  const [w, h] = win && !win.isDestroyed() ? win.getSize() : [PET_W, PET_H];
  switch (corner) {
    case 'top-left':
      return { x: workArea.x + margin, y: workArea.y + margin };
    case 'top-right':
      return { x: workArea.x + workArea.width - w - margin, y: workArea.y + margin };
    case 'bottom-left':
      return { x: workArea.x + margin, y: workArea.y + workArea.height - h - margin };
    case 'bottom-right':
    default:
      return { x: workArea.x + workArea.width - w - margin, y: workArea.y + workArea.height - h - margin };
  }
}
ipcMain.on('pet:relocate', (_e, corner) => {
  if (!win || win.isDestroyed()) return;
  const p = cornerPosition(corner);
  win.setPosition(p.x, p.y);
  patchState({ x: p.x, y: p.y });
});

ipcMain.handle('pet:get-scale', () => currentScale());
ipcMain.handle('pet:set-scale', (event, rawScale) => {
  const source = event.sender === controlWin?.webContents ? 'control-panel' : 'pet-overlay';
  return applyPetScale(rawScale, source);
});
ipcMain.handle('pet:reset-scale', (event) => {
  const source = event.sender === controlWin?.webContents ? 'control-panel-reset' : 'pet-overlay-reset';
  return applyPetScale(1, source);
});
ipcMain.handle('diagnostics:export', (event) => {
  const parentWindow = BrowserWindow.fromWebContents(event.sender);
  return exportDiagnostics(parentWindow);
});

// 60Hz 轮询光标位置 → 推给渲染层做 hit-test
// macOS 透明窗 + setIgnoreMouseEvents 不会把 mousemove 转发给 renderer，必须主进程主动喂
let cursorTimer = null;
let cursorInsidePetWindow = false;
function startCursorPoll() {
  if (cursorTimer) return;
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.webContents) return;
    const p = screen.getCursorScreenPoint();
    const [wx, wy] = win.getPosition();
    const [ww, wh] = win.getSize();
    const inside = p.x >= wx && p.x < wx + ww && p.y >= wy && p.y < wy + wh;
    cursorInsidePetWindow = inside;
    if (petDragging && !gameMode) {
      win.setPosition(Math.round(p.x - petDragOffset.x), Math.round(p.y - petDragOffset.y));
    }
    // PNG 动画桌宠不使用旧 VRM raycast。主进程以窗口范围作为可靠兜底，
    // 避免 renderer 的首次 clickable IPC 丢失后窗口永久保持鼠标穿透。
    // 游戏模式仍是无条件穿透锁，不受此处影响。
    if (!gameMode) win.setIgnoreMouseEvents(!inside);
    win.webContents.send('pet:cursor', {
      cx: p.x - wx,
      cy: p.y - wy,
      ww, wh, inside,
    });
  }, 16);
}
function stopCursorPoll() {
  if (cursorTimer) { clearInterval(cursorTimer); cursorTimer = null; }
}

// 扫预录台词目录 → 让渲染层知道有哪些可以播
// 命名规则：head_*.wav / body_*.wav / tail_*.wav / idle_*.wav
const VOICES_DIR = app.isPackaged
  ? path.join(__dirname, '..', '..', 'dist', 'voices')
  : path.join(__dirname, '..', '..', 'public', 'voices');
ipcMain.handle('pet:voices', () => {
  try {
    return fs.readdirSync(VOICES_DIR)
      .filter((f) => /\.(wav|mp3|ogg|m4a)$/i.test(f));
  } catch {
    return [];
  }
});

// 服务器地址：生产包优先读 config/production.json；开发期可用环境变量覆盖。
ipcMain.handle('pet:server-url', () => configuredServerUrl());

// 房间密钥：必须存在于 server 的 ROOM_SECRETS / ROOM_SECRET 中。真实密钥不要提交进 Git。
ipcMain.handle('pet:room-secret', () => configuredRoomSecret());

ipcMain.handle('pet:pairing-config', () => pairingSnapshot());
ipcMain.handle('pet:save-pairing-config', (_e, config) => {
  const next = {
    serverUrl: String(config?.serverUrl || '').trim(),
    roomSecret: String(config?.roomSecret || '').trim(),
    memberId: String(config?.memberId || '').trim(),
    deviceName: String(config?.deviceName || '').trim().slice(0, 80),
  };
  if (!next.serverUrl || !next.roomSecret || !['a', 'b'].includes(next.memberId) || !next.deviceName) {
    return { ok: false, error: 'serverUrl, roomSecret, memberId and deviceName required' };
  }
  const nextConfig = {
    ...pairingConfig,
    serverUrl: next.serverUrl,
    roomSecret: next.roomSecret,
    memberId: next.memberId,
    deviceName: next.deviceName,
    deviceId: pairingConfig.deviceId || pairingConfig.participantId || randomUUID(),
  };
  delete nextConfig.participantId;
  const ok = writeJson(pairingFile(), nextConfig);
  if (ok) Object.assign(pairingConfig, nextConfig);
  const snapshot = ok ? pairingSnapshot() : undefined;
  if (ok) {
    win?.webContents.send('pet:pairing-changed', snapshot);
    controlWin?.webContents.send('pet:pairing-changed', snapshot);
  }
  return ok ? { ok: true, config: snapshot } : { ok: false, error: 'write failed' };
});

ipcMain.handle('tts:get-credentials', () => {
  const apiKey = loadTtsApiKey();
  return { configured: !!apiKey, apiKey };
});
ipcMain.handle('tts:save-credentials', (_e, apiKey) => saveTtsApiKey(apiKey));

ipcMain.handle('pet:desktop-source-id', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
    });
    return sources[0]?.id || null;
  } catch {
    return null;
  }
});

function onDisplayMetricsChanged(_event, display, changedMetrics) {
  diagnostic('display-metrics-changed', {
    changedMetrics,
    display: displaySnapshot(display),
    petWindow: currentWindowSnapshot(),
  });
}

function onDisplayAdded(_event, display) {
  diagnostic('display-added', { display: displaySnapshot(display), displays: allDisplaySnapshots() });
}

function onDisplayRemoved(_event, display) {
  diagnostic('display-removed', { display: displaySnapshot(display), displays: allDisplaySnapshots() });
}

function onUncaughtException(error, origin) {
  diagnostic('uncaught-exception', {
    origin,
    name: error?.name,
    message: error?.message || String(error),
    stack: error?.stack,
  });
}

function onUnhandledRejection(reason) {
  diagnostic('unhandled-rejection', {
    name: reason?.name,
    message: reason?.message || String(reason),
    stack: reason?.stack,
  });
}

app.whenReady().then(() => {
  ensureDeviceId();
  ensureDefaultLaunchAtStartup();
  createWindow();
  createControlWindow();
  createTray();
  startCursorPoll();
  setupAutoUpdater();
  screen.on('display-metrics-changed', onDisplayMetricsChanged);
  screen.on('display-added', onDisplayAdded);
  screen.on('display-removed', onDisplayRemoved);
  process.on('uncaughtExceptionMonitor', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);
  diagnostic('app-started', diagnosticSnapshot());
  setTimeout(() => checkForPetUpdates(false), 3000);
  if (shouldShowControlOnStartup(pairingSnapshot())) showControlWindow();

  globalShortcut.register('Control+Alt+G', () => {
    setGameMode(!gameMode);
  });
  globalShortcut.register('Control+Alt+P', () => {
    showControlWindow();
  });
});

app.on('window-all-closed', (e) => {
  // 桌宠模式：关窗不退出
  e.preventDefault();
});

app.on('before-quit', () => {
  app.isQuiting = true;
});

app.on('will-quit', () => {
  petDragging = false;
  stopCursorPoll();
  screen.removeListener('display-metrics-changed', onDisplayMetricsChanged);
  screen.removeListener('display-added', onDisplayAdded);
  screen.removeListener('display-removed', onDisplayRemoved);
  process.removeListener('uncaughtExceptionMonitor', onUncaughtException);
  process.removeListener('unhandledRejection', onUnhandledRejection);
  globalShortcut.unregisterAll();
});
