// Modules to control application life and create native browser window
const {app, BrowserWindow, ipcMain} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const Store = require('electron-store');



// some const
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36';
const defaultWidth = 1270;
const defaultHeight = 750;



// portable use
// when you want to persist the data inside the executable directory just use this store config, please change the encryptionKey
// then you can use it as a portable app with saved config, size and position is only saved on non portable versions of this app
const portable = false;
const portableStoreCwd = path.join(process.resourcesPath, 'store');
const encryptionKey = '****';

// persistent store
if (portable && !fs.existsSync(portableStoreCwd)) {
  fs.mkdirSync(portableStoreCwd);
}

const store = portable ? new Store({ name: 'storage', fileExtension: 'db', cwd: portableStoreCwd, encryptionKey: encryptionKey }) : new Store();

const viewerWindows = new Map();
const viewerHealth = new Map();
let isQuitting = false;

let logFilePath;

const HEALTH_TIMEOUT_MS = 45_000;
const STALL_TIMEOUT_MS = 120_000;
const RECOVER_COOLDOWN_MS = 30_000;

const RECOVERY_WINDOW_MS = 10 * 60_000;
const HARD_RESTART_THRESHOLD = 5;
const HARD_RESTART_COOLDOWN_MS = 15 * 60_000;

function ensureLogFilePath() {
  if (logFilePath) return logFilePath;
  if (!app.isReady()) return undefined;

  try {
    const dir = app.getPath('userData');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    logFilePath = path.join(dir, 'unifi-protect-viewer.log');
    return logFilePath;
  } catch (_) {
    return undefined;
  }
}

function logEvent(level, msg, meta = undefined) {
  const line = `${new Date().toISOString()} [${level}] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}`;
  try {
    console.log(line);
  } catch (_) {}

  try {
    const p = ensureLogFilePath();
    if (!p) return;
    fs.appendFile(p, `${line}\n`, () => {});
  } catch (_) {}
}

function handleViewerEvent(event, payload) {
  try {
    const idx = Number(payload?.screenIndex);
    const type = String(payload?.type || '');

    if (!type) return;

    const atMs = Number(payload?.atMs ?? payload?.at);
    const atIso = payload?.atIso
      ? String(payload.atIso)
      : (Number.isFinite(atMs) ? new Date(atMs).toISOString() : undefined);

    const meta = {
      screenIndex: Number.isFinite(idx) ? idx : undefined,
      type,
      atMs: Number.isFinite(atMs) ? atMs : Date.now(),
      atIso,
      fromPath: payload?.fromPath ? String(payload.fromPath) : undefined,
      toPath: payload?.toPath ? String(payload.toPath) : undefined,
      note: payload?.note ? String(payload.note) : undefined,
    };

    logEvent('INFO', 'Viewer event', meta);
  } catch (_) {
  }
}

function hardRelaunch(reason, meta = undefined) {
  if (isQuitting) return;
  const now = Date.now();
  const last = Number(store.get('lastHardRestartAt') || 0);
  if (now - last < HARD_RESTART_COOLDOWN_MS) return;

  store.set('lastHardRestartAt', now);
  logEvent('ERROR', 'Hard relaunch triggered', { reason, ...meta });

  isQuitting = true;
  try {
    app.relaunch();
  } catch (_) {
  }
  try {
    app.exit(0);
  } catch (_) {
  }
}



// cause self-signed certificate
app.commandLine.appendSwitch('ignore-certificate-errors', 'true');



// dev
try {
  require('electron-reloader')(module)
} catch (_) {}



// event handlers
function handleReset() {
  store.clear();
}

function handleRestart() {
  app.quit();
  app.relaunch();
}

async function handleConfigLoad() {
  return store.get('config');
}

function handleConfigSave(event, config) {
  store.set('config', config);
}

// window state helpers
function getWindowState(index = 0) {
  const states = store.get('windowStates') || [];
  return states[index] || {};
}

function saveWindowState(index, win) {
  if (!store.has('init') || portable) return;

  const states = store.get('windowStates') || [];
  states[index] = {
    bounds: win.getBounds(),
    isFullScreen: win.isFullScreen(),
    isMaximized: win.isMaximized(),
  };

  store.set('windowStates', states);
}

function getDesiredScreensConfig() {
  const config = store.get('config') || {};
  const screens = Math.max(1, Math.min(Number(config?.screens ?? 1) || 1, 6));
  const screensConfig = Array.isArray(config?.screensConfig) ? config.screensConfig : [];
  return { config, screens, screensConfig };
}

async function recreateViewerWindow(index, reason = '') {
  const old = viewerWindows.get(index);
  if (old && !old.isDestroyed()) {
    try { old.destroy(); } catch (_) {}
  }
  viewerWindows.delete(index);

  logEvent('WARN', 'Recreate viewer window', { index, reason });

  if (!store.has('config')) return;

  const { screens, screensConfig } = getDesiredScreensConfig();
  if (index < 0 || index >= screens) return;

  const perScreen = screensConfig[index] || {};
  const titleSuffix = screens > 1 ? `Screen ${index + 1}` : '';

  try {
    await createViewerWindow(perScreen.url || undefined, index, false, titleSuffix, !!perScreen.maximize);
  } catch (_) {
  }
}

function tryReloadViewerWindow(index) {
  const win = viewerWindows.get(index);
  if (!win || win.isDestroyed()) {
    recreateViewerWindow(index, 'missing').then();
    return;
  }

  try {
    logEvent('WARN', 'Reload viewer window', { index });
    win.webContents.reloadIgnoringCache();
  } catch (_) {
    recreateViewerWindow(index, 'reload-failed').then();
  }
}

function noteRecovery(index, reason = '') {
  const state = viewerHealth.get(index) || {};
  const now = Date.now();
  const history = Array.isArray(state.recoverHistory) ? state.recoverHistory : [];
  const updatedHistory = history
    .filter(t => Number.isFinite(t) && now - t < RECOVERY_WINDOW_MS)
    .concat([now]);

  viewerHealth.set(index, {
    ...state,
    lastRecoverAt: now,
    recoverCount: (state.recoverCount || 0) + 1,
    recoverHistory: updatedHistory,
  });

  logEvent('WARN', 'Recovery action', { index, reason, recoveriesInWindow: updatedHistory.length });

  if (updatedHistory.length >= HARD_RESTART_THRESHOLD) {
    hardRelaunch('too_many_recoveries', { index, recoveriesInWindow: updatedHistory.length });
  }
}

function handleViewerHealth(event, payload) {
  const idx = Number(payload?.screenIndex);
  if (!Number.isFinite(idx)) return;

  const now = Date.now();
  const video = payload?.video || {};
  const prev = viewerHealth.get(idx) || {};

  const href = String(payload?.href || '');
  const maxCurrentTime = Number(video?.maxCurrentTime);
  const prevMax = Number(prev.lastMaxCurrentTime);

  let hasProgress = false;
  if (Number.isFinite(maxCurrentTime) && Number.isFinite(prevMax)) {
    const isReset = maxCurrentTime + 2 < prevMax;
    hasProgress = isReset || (maxCurrentTime > prevMax + 0.25);
  } else {
    hasProgress = Number.isFinite(maxCurrentTime);
  }

  if (prev.lastHref && href && href !== prev.lastHref) {
    hasProgress = true;
  }

  const shouldTrackStall = (video?.count || 0) > 0 && !!video?.anyPlaying;

  viewerHealth.set(idx, {
    ...prev,
    lastSeenAt: now,
    lastHref: href,
    lastVideo: video,
    lastMaxCurrentTime: Number.isFinite(maxCurrentTime) ? maxCurrentTime : (prev.lastMaxCurrentTime ?? 0),
    lastProgressAt: shouldTrackStall
      ? (hasProgress ? now : (prev.lastProgressAt || now))
      : now,
  });
}

function startWatchdog() {
  setInterval(() => {
    if (!store.has('config')) return;

    const { screens } = getDesiredScreensConfig();
    const now = Date.now();

    for (let i = 0; i < screens; i++) {
      const win = viewerWindows.get(i);
      if (!win || win.isDestroyed()) {
        recreateViewerWindow(i, 'missing').then();
        continue;
      }

      const health = viewerHealth.get(i);
      const lastRecoverAt = health?.lastRecoverAt || 0;
      const allowRecover = (now - lastRecoverAt) > RECOVER_COOLDOWN_MS;

      if (health?.lastSeenAt && (now - health.lastSeenAt) > HEALTH_TIMEOUT_MS) {
        if (allowRecover) {
          noteRecovery(i, 'heartbeat_timeout');
          tryReloadViewerWindow(i);
        }
        continue;
      }

      if (health?.lastProgressAt && (now - health.lastProgressAt) > STALL_TIMEOUT_MS) {
        if (allowRecover) {
          noteRecovery(i, 'stream_stall');
          tryReloadViewerWindow(i);
        }
      }
    }
  }, 15_000);
}

// window handler
async function handleWindow(mainWindow, urlOverride = undefined, allowConfigFallback = true) {
  if (store.has('config') && (urlOverride || store.get('config')?.url)) {
    // do not await here, the file is the fallback if the url cannot be loaded
    mainWindow.loadFile('./src/html/index.html').then();

    await mainWindow.loadURL(urlOverride || store.get('config').url, {
      userAgent: userAgent
    });
  } else if (allowConfigFallback) {
    await mainWindow.loadFile('./src/html/config.html');
  }

  if (!store.has('init')) {
    store.set('init', true);
  }
}



async function createViewerWindow (urlOverride = undefined, index = 0, allowConfigFallback = true, titleSuffix = '', maximizeHint = false) {
  const state = getWindowState(index);

  const mainWindow = new BrowserWindow({
    width: state?.bounds?.width || defaultWidth,
    height: state?.bounds?.height || defaultHeight,
    x: state?.bounds?.x ?? undefined,
    y: state?.bounds?.y ?? undefined,
    fullscreen: state?.isFullScreen || false,
    webPreferences: {
      nodeIntegration: false,
      spellcheck: true,
      preload: path.join(__dirname, '/src/js/preload.js'),
      additionalArguments: [`--upv-screen=${index}`],
      backgroundThrottling: false,
      allowDisplayingInsecureContent: true,
      allowRunningInsecureContent: true
    },

    icon: path.join(__dirname, '/src/img/128.png'),

    frame: true,
    movable: true,
    resizable: true,
    closable: true,
    darkTheme: true,
    autoHideMenuBar: true,
  });

  if (state?.isMaximized || (!state?.bounds && maximizeHint)) {
    mainWindow.maximize();
  }

  // set the window title
  mainWindow.setTitle(`UnifiProtect Viewer${titleSuffix ? ` - ${titleSuffix}` : ''}`);

  // disable automatic app title updates
  mainWindow.on('page-title-updated', function(e) {
    e.preventDefault()
  });

  const persistState = () => saveWindowState(index, mainWindow);

  // save bounds to store on close
  mainWindow.on("close", persistState);
  mainWindow.on("enter-full-screen", persistState);
  mainWindow.on("leave-full-screen", persistState);
  mainWindow.on("resize", persistState);
  mainWindow.on("move", persistState);

  // and load the index.html or target url of the app.
  await handleWindow(mainWindow, urlOverride, allowConfigFallback);

  viewerWindows.set(index, mainWindow);

  mainWindow.on('unresponsive', () => {
    if (isQuitting) return;
    noteRecovery(index, 'unresponsive');
    tryReloadViewerWindow(index);
  });

  mainWindow.webContents.on('render-process-gone', () => {
    if (isQuitting) return;
    noteRecovery(index, 'render_process_gone');
    recreateViewerWindow(index, 'render-gone').then();
  });

  mainWindow.on('closed', () => {
    viewerWindows.delete(index);
    if (isQuitting) return;
    noteRecovery(index, 'closed');
    recreateViewerWindow(index, 'closed').then();
  });

  return mainWindow;
}



async function createWindows () {
  // when no config yet, open a single window that loads config
  if (!store.has('config')) {
    await createViewerWindow(undefined, 0, true, '');
    return;
  }

  const config = store.get('config');
  const screens = Math.max(1, Math.min(Number(config?.screens ?? 1) || 1, 6));
  const screensConfig = Array.isArray(config?.screensConfig) ? config.screensConfig : [];

  for (let i = 0; i < screens; i++) {
    const titleSuffix = screens > 1 ? `Screen ${i + 1}` : '';
    const perScreen = screensConfig[i] || {};
    await createViewerWindow(perScreen.url || undefined, i, false, titleSuffix, !!perScreen.maximize);
  }
}



// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  app.on('before-quit', () => {
    isQuitting = true;
  });

  logEvent('INFO', 'App started', { version: app.getVersion(), platform: process.platform });

  ipcMain.on('reset', handleReset);
  ipcMain.on('restart', handleRestart);
  ipcMain.on('configSave', handleConfigSave);
  ipcMain.on('viewerHealth', handleViewerHealth);
  ipcMain.on('viewerEvent', handleViewerEvent);

  ipcMain.handle('configLoad', handleConfigLoad)

  await createWindows();

  startWatchdog();

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindows()
  });
});



// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit()
})



// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.


