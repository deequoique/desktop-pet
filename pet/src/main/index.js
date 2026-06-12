const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, globalShortcut, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');

const DEV_URL = 'http://localhost:5173';
const isDev = !app.isPackaged;
// scale=1 的基准尺寸；实际窗口 = 基准 * scale。
const PET_W = 360;
const PET_H = 480;
const MIN_SCALE = 0.5;
const MAX_SCALE = 2.0;

const clampScale = (s) => {
  const n = Number(s);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, n));
};

const stateFile = () => path.join(app.getPath('userData'), 'pet-state.json');

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
  return clampScale(s && s.scale != null ? s.scale : 1);
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
let tray = null;

function createWindow() {
  const saved = loadState();
  const scale = clampScale(saved && saved.scale != null ? saved.scale : 1);
  const w = Math.round(PET_W * scale);
  const h = Math.round(PET_H * scale);
  const hasPos = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y);
  // 无保存位置：按当前尺寸贴右下角。
  const fallbackPos = (() => {
    const { workArea } = screen.getPrimaryDisplay();
    return { x: workArea.x + workArea.width - w - 16, y: workArea.y + workArea.height - h - 16 };
  })();
  const pos = hasPos ? saved : fallbackPos;

  win = new BrowserWindow({
    width: w,
    height: h,
    x: pos.x,
    y: pos.y,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 默认整窗穿透；渲染层 raycast 命中模型时再切换。
  // 注意：macOS 上 forward:true 不可靠，所以我们用主进程轮询 cursor，不依赖 OS 转发。
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  if (isDev) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  win.on('moved', () => {
    const [x, y] = win.getPosition();
    patchState({ x, y });
  });
}

function createTray() {
  // 单色 template 图标（Mac 自动反色；Windows 也能用 png）
  const img = nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('Desktop Pet');
  const menu = Menu.buildFromTemplate([
    { label: 'Reset Position', click: () => {
        const p = defaultBottomRight();
        win?.setPosition(p.x, p.y);
        patchState({ x: p.x, y: p.y });
      } },
    { label: 'Reload', click: () => win?.reload() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

// 渲染层根据 raycast 结果告诉我们鼠标是否在模型上
ipcMain.on('pet:set-clickable', (_e, clickable) => {
  if (!win || win.isDestroyed()) return;
  if (clickable) {
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

// 远程/本地 resize：scale → 重算窗口尺寸，锚定底部中心，避免缩放跑位。
ipcMain.on('pet:resize', (_e, rawScale) => {
  if (!win || win.isDestroyed()) return;
  const scale = clampScale(rawScale);
  const w = Math.round(PET_W * scale);
  const h = Math.round(PET_H * scale);
  const b = win.getBounds();
  const x = Math.round(b.x + (b.width - w) / 2);
  const y = Math.round(b.y + (b.height - h));
  win.setBounds({ x, y, width: w, height: h });
  patchState({ x, y, scale });
});

ipcMain.handle('pet:get-scale', () => currentScale());

// 60Hz 轮询光标位置 → 推给渲染层做 hit-test
// macOS 透明窗 + setIgnoreMouseEvents 不会把 mousemove 转发给 renderer，必须主进程主动喂
let cursorTimer = null;
function startCursorPoll() {
  if (cursorTimer) return;
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.webContents) return;
    const p = screen.getCursorScreenPoint();
    const [wx, wy] = win.getPosition();
    const [ww, wh] = win.getSize();
    const inside = p.x >= wx && p.x < wx + ww && p.y >= wy && p.y < wy + wh;
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
const VOICES_DIR = path.join(__dirname, '..', '..', 'public', 'voices');
ipcMain.handle('pet:voices', () => {
  try {
    return fs.readdirSync(VOICES_DIR)
      .filter((f) => /\.(wav|mp3|ogg|m4a)$/i.test(f));
  } catch {
    return [];
  }
});

// 服务器地址（dev 期写死，部署后从配置读）
ipcMain.handle('pet:server-url', () => process.env.PET_SERVER_URL || 'http://localhost:3030');

// 房间密钥（M4 远程控制）；和 server/.env 的 ROOM_SECRET 对齐。
// 没设就用 'change-me'（和 server 默认对齐，本机 dev 直接跑）。
ipcMain.handle('pet:room-secret', () => process.env.PET_ROOM_SECRET || 'change-me');

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

app.whenReady().then(() => {
  createWindow();
  createTray();
  startCursorPoll();

  // 全局快捷键：唤起文字输入框（M3 是文字对话，不是录音）
  globalShortcut.register('Control+Alt+D', () => {
    win?.webContents.send('pet:hotkey', 'toggle-chat');
  });
});

app.on('window-all-closed', (e) => {
  // 桌宠模式：关窗不退出
  e.preventDefault();
});

app.on('will-quit', () => {
  stopCursorPoll();
  globalShortcut.unregisterAll();
});
