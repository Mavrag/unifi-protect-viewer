function createWatchdog({
  store,
  viewerWindows,
  viewerHealth,
  logEvent,
  hardRelaunch,
  getDesiredScreensConfig,
  recreateViewerWindow,
  tryReloadViewerWindow,
  HEALTH_TIMEOUT_MS,
  STALL_TIMEOUT_MS,
  RECOVER_COOLDOWN_MS,
  RECOVERY_WINDOW_MS,
  HARD_RESTART_THRESHOLD,
}) {
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
          recreateViewerWindow(i, 'missing').catch(() => {});
          continue;
        }

        const health = viewerHealth.get(i);
        const lastRecoverAt = health?.lastRecoverAt || 0;
        const allowRecover = (now - lastRecoverAt) > RECOVER_COOLDOWN_MS;

        let currentUrl = '';
        try {
          currentUrl = String(win.webContents.getURL() || '');
        } catch (_) {
        }

        if (allowRecover && (currentUrl.startsWith('about:blank') || currentUrl.startsWith('chrome-error://'))) {
          noteRecovery(i, 'blank_or_error_url');
          tryReloadViewerWindow(i);
          continue;
        }

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

  return { noteRecovery, handleViewerHealth, startWatchdog };
}

module.exports = { createWatchdog };
