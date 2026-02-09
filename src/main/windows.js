const { pathToFileURL } = require('node:url');

function createWindowsManager({
  BrowserWindow,
  store,
  viewerWindows,
  portable,
  path,
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

  const NETWORK_ERROR_CODES = new Set([
    -2,    // ERR_FAILED
    -7,    // ERR_TIMED_OUT
    -21,   // ERR_NETWORK_CHANGED
    -100,  // ERR_CONNECTION_CLOSED
    -101,  // ERR_CONNECTION_RESET
    -102,  // ERR_CONNECTION_REFUSED
    -104,  // ERR_CONNECTION_FAILED
    -105,  // ERR_NAME_NOT_RESOLVED
    -106,  // ERR_INTERNET_DISCONNECTED
    -109,  // ERR_ADDRESS_UNREACHABLE
    -118,  // ERR_CONNECTION_TIMED_OUT
    -137,  // ERR_NAME_RESOLUTION_FAILED
  ]);

  function isNetworkError(errorCode) {
    return NETWORK_ERROR_CODES.has(errorCode);
  }

  function showOfflineAndRetry(mainWindow, index, errorCode, errorDescription) {
    if (isQuitting()) return;
    const wc = mainWindow?.webContents;
    if (!wc || wc.isDestroyed()) return;

    const now = Date.now();
    const desiredUrl = getDesiredUrlForIndex(index);
    const attempt = Number(wc.__upvNetFailCount || 0) + 1;
    wc.__upvNetFailCount = attempt;

    // show offline page (throttle to avoid flicker)
    try {
      const lastOfflineAt = Number(wc.__upvLastOfflineAt || 0);
      if (now - lastOfflineAt > 3_000) {
        wc.__upvLastOfflineAt = now;
        const offlinePath = path.join(__dirname, '..', 'html', 'offline.html');
        const offlineBase = pathToFileURL(offlinePath).toString();
        const offlineUrl = `${offlineBase}?screen=${encodeURIComponent(String(index))}`
          + `&url=${encodeURIComponent(String(desiredUrl || ''))}`
          + `&errorCode=${encodeURIComponent(String(errorCode))}`
          + `&errorDescription=${encodeURIComponent(String(errorDescription || ''))}`
          + `&attempt=${encodeURIComponent(String(attempt))}`;
        wc.loadURL(offlineUrl).catch(() => {});
      }
    } catch (_) {
    }

    // skip if a retry is already scheduled or in-flight
    if (wc.__upvNetFailTimer || wc.__upvRetryInFlight) return;

    const delayMs = Math.min(60_000, Math.max(15_000, 2000 * (2 ** Math.min(5, attempt))));
    wc.__upvNetFailTimer = setTimeout(async () => {
      try {
        wc.__upvNetFailTimer = undefined;
        if (isQuitting()) return;
        if (!desiredUrl) return;
        if (wc.isDestroyed()) return;

        wc.__upvRetryInFlight = true;
        try {
          await wc.loadURL(desiredUrl, { userAgent });
        } finally {
          wc.__upvRetryInFlight = false;
        }
      } catch (_) {
        wc.__upvRetryInFlight = false;
      }
    }, delayMs);

    try {
      const lastRetryLog = Number(wc.__upvLastNetFailRetryLogAt || 0);
      if (now - lastRetryLog > 10_000) {
        wc.__upvLastNetFailRetryLogAt = now;
        logEvent('WARN', 'Network load failed; retry scheduled', {
          index,
          errorCode,
          errorDescription,
          attempt,
          delayMs,
        });
      }
    } catch (_) {
    }
  }

  function getDesiredUrlForIndex(index = 0) {
    try {
      const { config, screensConfig } = getDesiredScreensConfig();
      const perScreen = (Array.isArray(screensConfig) ? screensConfig[index] : undefined) || {};
      return String((perScreen?.url || config?.url || '')).trim();
    } catch (_) {
      return '';
    }
  }

  function attachNavigationGuards(win, index) {
    const wc = win?.webContents;
    if (!wc) return;

    const normalizePath = (u) => {
      try {
        const url = new URL(String(u));
        return String(url.pathname || '').replace(/\/+$/, '');
      } catch (_) {
        return '';
      }
    };

    const isDriftPath = (p) => p === '/protect/dashboard/all' || p === '/protect/dashboard';

    const getDesired = () => {
      const desiredUrl = getDesiredUrlForIndex(index);
      const desiredPath = normalizePath(desiredUrl);
      return { desiredUrl, desiredPath };
    };

    const throttleOk = () => {
      try {
        const now = Date.now();
        const last = Number(wc.__upvLastDriftFixAt || 0);
        if (now - last < 1500) return false;
        wc.__upvLastDriftFixAt = now;
        return true;
      } catch (_) {
        return true;
      }
    };

    const softCorrect = (reason, url) => {
      const { desiredUrl, desiredPath } = getDesired();
      if (!desiredUrl || !desiredPath) return;

      const fromUrl = (() => {
        try { return String(wc.getURL() || ''); } catch (_) { return ''; }
      })();

      if (!throttleOk()) return;

      try {
        logEvent('WARN', 'Dashboard drift', {
          index,
          reason,
          fromPath: normalizePath(fromUrl),
          toPath: normalizePath(url),
          desiredPath,
        });
      } catch (_) {
      }

      try {
        wc.executeJavaScript(
          `try{history.replaceState(history.state,'',${JSON.stringify(desiredUrl)});dispatchEvent(new PopStateEvent('popstate'));}catch(_){}`,
          true
        ).catch(() => {});
      } catch (_) {
      }

      setTimeout(() => {
        try {
          const cur = normalizePath(wc.getURL());
          if (isDriftPath(cur)) {
            wc.loadURL(desiredUrl, { userAgent }).catch(() => {});
          }
        } catch (_) {
        }
      }, 250);
    };

    const handleTarget = (event, url, reason, canPrevent) => {
      try {
        const { desiredUrl, desiredPath } = getDesired();
        if (!desiredUrl || !desiredPath) return;

        const targetPath = normalizePath(url);
        if (!isDriftPath(targetPath)) return;
        if (targetPath === desiredPath) return;

        if (canPrevent && event && typeof event.preventDefault === 'function') {
          event.preventDefault();
          if (!throttleOk()) return;
          try {
            logEvent('WARN', 'Dashboard drift prevented', {
              index,
              reason,
              toPath: targetPath,
              desiredPath,
            });
          } catch (_) {
          }
          try {
            wc.loadURL(desiredUrl, { userAgent }).catch(() => {});
          } catch (_) {
          }
          return;
        }

        softCorrect(reason, url);
      } catch (_) {
      }
    };

    try {
      wc.on('will-navigate', (event, url) => handleTarget(event, url, 'will-navigate', true));
    } catch (_) {
    }

    try {
      wc.on('will-redirect', (event, url) => handleTarget(event, url, 'will-redirect', true));
    } catch (_) {
    }

    try {
      wc.on('did-navigate-in-page', (event, url, isMainFrame) => {
        if (!isMainFrame) return;
        handleTarget(event, url, 'did-navigate-in-page', false);
      });
    } catch (_) {
    }
  }

  async function handleWindow(mainWindow, urlOverride = undefined, allowConfigFallback = true, index = 0) {
    if (store.has('config') && (urlOverride || store.get('config')?.url)) {
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

        // show offline page so the user sees something useful instead of black screen
        const errorCode = parseInt(String(msg).match(/\((-?\d+)\)/)?.[1] || '0', 10);
        if (isNetworkError(errorCode) || !mainWindow.webContents.getURL().startsWith('http')) {
          showOfflineAndRetry(mainWindow, index, errorCode, msg);
        }
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

    const desiredUrlForPreload = String(urlOverride || getDesiredUrlForIndex(index) || '').trim();
    const desiredUrlArg = desiredUrlForPreload ? encodeURIComponent(desiredUrlForPreload) : '';

    const mainWindow = new BrowserWindow({
      width: state?.bounds?.width || defaultWidth,
      height: state?.bounds?.height || defaultHeight,
      x: state?.bounds?.x ?? undefined,
      y: state?.bounds?.y ?? undefined,
      fullscreen: state?.isFullScreen || false,
      webPreferences: {
        nodeIntegration: false,
        spellcheck: false,
        preload: preloadPath,
        additionalArguments: [`--upv-screen=${index}`, `--upv-url=${desiredUrlArg}`],
        backgroundThrottling: false,
        allowDisplayingInsecureContent: true,
        allowRunningInsecureContent: true
      },

      icon: iconPath,
      backgroundColor: '#0b1220',

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

    mainWindow.loadFile('./src/html/index.html').catch(() => {});

    attachNavigationGuards(mainWindow, index);

    mainWindow.setTitle(`UnifiProtect Viewer${titleSuffix ? ` - ${titleSuffix}` : ''}`);

    mainWindow.on('page-title-updated', function(e) {
      e.preventDefault()
    });

    const persistState = () => saveWindowState(index, mainWindow);
    let persistTimer;
    const persistDebounced = () => {
      clearTimeout(persistTimer);
      persistTimer = setTimeout(persistState, 500);
    };

    mainWindow.on("close", persistState);
    mainWindow.on("enter-full-screen", persistState);
    mainWindow.on("leave-full-screen", persistState);
    mainWindow.on("resize", persistDebounced);
    mainWindow.on("move", persistDebounced);

    await handleWindow(mainWindow, urlOverride, allowConfigFallback, index);

    viewerWindows.set(index, mainWindow);

    mainWindow.on('unresponsive', () => {
      if (isQuitting()) return;
      const noteRecovery = typeof getNoteRecovery === 'function' ? getNoteRecovery() : undefined;
      if (typeof noteRecovery === 'function') noteRecovery(index, 'unresponsive');
      tryReloadViewerWindow(index);
    });

    mainWindow.webContents.on('render-process-gone', (_, details) => {
      if (isQuitting()) return;
      const noteRecovery = typeof getNoteRecovery === 'function' ? getNoteRecovery() : undefined;
      if (typeof noteRecovery === 'function') noteRecovery(index, 'render_process_gone');
      try {
        logEvent('WARN', 'Render process gone', {
          index,
          reason: details?.reason,
          exitCode: details?.exitCode,
        });
      } catch (_) {
      }
      recreateViewerWindow(index, 'render-gone').catch(() => {});
    });

    mainWindow.webContents.on('did-fail-load', (_, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      if (isQuitting()) return;

      const now = Date.now();
      try {
        const lastLog = Number(mainWindow.webContents.__upvLastDidFailLoadLogAt || 0);
        if (now - lastLog > 2_000) {
          mainWindow.webContents.__upvLastDidFailLoadLogAt = now;
          logEvent('WARN', 'did-fail-load', {
            index,
            errorCode,
            errorDescription,
            url: String(validatedURL || ''),
          });
        }
      } catch (_) {
      }

      if (isNetworkError(errorCode)) {
        showOfflineAndRetry(mainWindow, index, errorCode, errorDescription);
        return;
      }

      try {
        const lastFix = Number(mainWindow.webContents.__upvLastFailLoadFixAt || 0);
        if (now - lastFix < 1500) return;
        mainWindow.webContents.__upvLastFailLoadFixAt = now;
      } catch (_) {
      }

      const noteRecovery = typeof getNoteRecovery === 'function' ? getNoteRecovery() : undefined;
      if (typeof noteRecovery === 'function') noteRecovery(index, 'did_fail_load');
      setTimeout(() => tryReloadViewerWindow(index), 250);
    });

    mainWindow.webContents.on('did-finish-load', () => {
      try {
        const desiredUrl = getDesiredUrlForIndex(index);
        const desiredOrigin = (() => {
          try { return new URL(String(desiredUrl)).origin; } catch (_) { return ''; }
        })();
        if (!desiredOrigin) return;
        const cur = String(mainWindow.webContents.getURL() || '');
        if (!cur.startsWith(desiredOrigin)) return;

        mainWindow.webContents.__upvNetFailCount = 0;
        mainWindow.webContents.__upvLastNetFailRetryLogAt = 0;
      } catch (_) {
      }
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
