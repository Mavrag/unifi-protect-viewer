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
  ipcMain.on('reset', handleReset);
  ipcMain.on('restart', handleRestart);
  ipcMain.on('configSave', handleConfigSave);

  ipcMain.handle('configLoad', handleConfigLoad)

  await createWindows();

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


