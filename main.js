const {app, BrowserWindow, ipcMain} = require('electron');
const path = require('node:path');

const { createLogger } = require('./src/main/logging');
const { createWatchdog } = require('./src/main/watchdog');
const { createWindowsManager } = require('./src/main/windows');
const { createStore } = require('./src/main/store');


const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const defaultWidth = 1270;
const defaultHeight = 750;


const portable = false;
const portableStoreCwd = path.join(process.resourcesPath, 'store');
const encryptionKey = '****';

const store = createStore({
  portable,
  portableStoreCwd,
  encryptionKey,
});

const viewerWindows = new Map();
const viewerHealth = new Map();
let isQuitting = false;

const { logEvent, handleViewerEvent } = createLogger(app);

let noteRecovery;
let handleViewerHealth;
let startWatchdog;

const HEALTH_TIMEOUT_MS = 45_000;
const STALL_TIMEOUT_MS = 120_000;
const RECOVER_COOLDOWN_MS = 30_000;

const RECOVERY_WINDOW_MS = 10 * 60_000;
const HARD_RESTART_THRESHOLD = 5;
const HARD_RESTART_COOLDOWN_MS = 15 * 60_000;

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

const windowsManager = createWindowsManager({
  BrowserWindow,
  store,
  viewerWindows,
  portable,
  defaultWidth,
  defaultHeight,
  userAgent,
  preloadPath: path.join(__dirname, '/src/js/preload.js'),
  iconPath: path.join(__dirname, '/src/img/128.png'),
  isQuitting: () => isQuitting,
  logEvent,
  getNoteRecovery: () => noteRecovery,
});

({ noteRecovery, handleViewerHealth, startWatchdog } = createWatchdog({
  store,
  viewerWindows,
  viewerHealth,
  logEvent,
  hardRelaunch,
  getDesiredScreensConfig: windowsManager.getDesiredScreensConfig,
  recreateViewerWindow: windowsManager.recreateViewerWindow,
  tryReloadViewerWindow: windowsManager.tryReloadViewerWindow,
  HEALTH_TIMEOUT_MS,
  STALL_TIMEOUT_MS,
  RECOVER_COOLDOWN_MS,
  RECOVERY_WINDOW_MS,
  HARD_RESTART_THRESHOLD,
}));


app.commandLine.appendSwitch('ignore-certificate-errors', 'true');

try {
  require('electron-reloader')(module)
} catch (_) {}


function handleReset() {
  store.clear();
}

function handleRestart() {
  app.relaunch();
  app.quit();
}

async function handleConfigLoad() {
  return store.get('config');
}

function handleConfigSave(event, config) {
  store.set('config', config);
}


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

  await windowsManager.createWindows();

  startWatchdog();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) windowsManager.createWindows().catch(() => {})
  });
});


app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit()
});
