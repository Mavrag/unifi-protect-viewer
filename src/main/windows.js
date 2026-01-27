function createWindowsManager({
  BrowserWindow,
  store,
  viewerWindows,
  portable,
  defaultWidth,
  defaultHeight,
  userAgent,
  preloadPath,
  iconPath,
  isQuitting,
  logEvent,
  getNoteRecovery,
}) {
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

  async function handleWindow(mainWindow, urlOverride = undefined, allowConfigFallback = true) {
    if (store.has('config') && (urlOverride || store.get('config')?.url)) {
      mainWindow.loadFile('./src/html/index.html').catch(() => {});

      try {
        await mainWindow.loadURL(urlOverride || store.get('config').url, {
          userAgent: userAgent
        });
      } catch (e) {
        const msg = String(e?.message || e || '');
        if (msg.includes('ERR_ABORTED') || msg.includes('(-3)')) {
          return;
        }
        logEvent('WARN', 'loadURL failed', { message: msg });
      }
    } else if (allowConfigFallback) {
      await mainWindow.loadFile('./src/html/config.html');
    }

    if (!store.has('init')) {
      store.set('init', true);
    }
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
      recreateViewerWindow(index, 'missing').catch(() => {});
      return;
    }

    try {
      logEvent('WARN', 'Reload viewer window', { index });
      win.webContents.reloadIgnoringCache();
    } catch (_) {
      recreateViewerWindow(index, 'reload-failed').catch(() => {});
    }
  }

  async function createViewerWindow(urlOverride = undefined, index = 0, allowConfigFallback = true, titleSuffix = '', maximizeHint = false) {
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
        preload: preloadPath,
        additionalArguments: [`--upv-screen=${index}`],
        backgroundThrottling: false,
        allowDisplayingInsecureContent: true,
        allowRunningInsecureContent: true
      },

      icon: iconPath,

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

    mainWindow.setTitle(`UnifiProtect Viewer${titleSuffix ? ` - ${titleSuffix}` : ''}`);

    mainWindow.on('page-title-updated', function(e) {
      e.preventDefault()
    });

    const persistState = () => saveWindowState(index, mainWindow);

    mainWindow.on("close", persistState);
    mainWindow.on("enter-full-screen", persistState);
    mainWindow.on("leave-full-screen", persistState);
    mainWindow.on("resize", persistState);
    mainWindow.on("move", persistState);

    await handleWindow(mainWindow, urlOverride, allowConfigFallback);

    viewerWindows.set(index, mainWindow);

    mainWindow.on('unresponsive', () => {
      if (isQuitting()) return;
      const noteRecovery = typeof getNoteRecovery === 'function' ? getNoteRecovery() : undefined;
      if (typeof noteRecovery === 'function') noteRecovery(index, 'unresponsive');
      tryReloadViewerWindow(index);
    });

    mainWindow.webContents.on('render-process-gone', () => {
      if (isQuitting()) return;
      const noteRecovery = typeof getNoteRecovery === 'function' ? getNoteRecovery() : undefined;
      if (typeof noteRecovery === 'function') noteRecovery(index, 'render_process_gone');
      recreateViewerWindow(index, 'render-gone').catch(() => {});
    });

    mainWindow.on('closed', () => {
      viewerWindows.delete(index);
      if (isQuitting()) return;
      const noteRecovery = typeof getNoteRecovery === 'function' ? getNoteRecovery() : undefined;
      if (typeof noteRecovery === 'function') noteRecovery(index, 'closed');
      recreateViewerWindow(index, 'closed').catch(() => {});
    });

    return mainWindow;
  }

  async function createWindows() {
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

  return {
    getDesiredScreensConfig,
    recreateViewerWindow,
    tryReloadViewerWindow,
    createViewerWindow,
    createWindows,
  };
}

module.exports = { createWindowsManager };
