// Modules to control application life and create native browser window
const {app, BrowserWindow, ipcMain} = require('electron');
const path = require('node:path');

const { createLogger } = require('./src/main/logging');
const { createWatchdog } = require('./src/main/watchdog');
const { createWindowsManager } = require('./src/main/windows');
const { createStore } = require('./src/main/store');



// some const
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const defaultWidth = 1270;
const defaultHeight = 750;



// portable use
// when you want to persist the data inside the executable directory just use this store config, please change the encryptionKey
// then you can use it as a portable app with saved config, size and position is only saved on non portable versions of this app
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
  path,
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
  app.relaunch();
  app.quit();
}

async function handleConfigLoad() {
  return store.get('config');
}

function handleConfigSave(event, config) {
  store.set('config', config);
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

  await windowsManager.createWindows();

  startWatchdog();

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) windowsManager.createWindows().catch(() => {})
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


