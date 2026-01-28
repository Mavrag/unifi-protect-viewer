const fs = require('node:fs');
const path = require('node:path');

function createLogger(app) {
  let logFilePath;

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
        href: payload?.href ? String(payload.href) : undefined,
        visibilityState: payload?.visibilityState ? String(payload.visibilityState) : undefined,
        hasFocus: typeof payload?.hasFocus === 'boolean' ? payload.hasFocus : undefined,
        stack: payload?.stack ? String(payload.stack).slice(0, 1200) : undefined,
      };

      logEvent('INFO', 'Viewer event', meta);
    } catch (_) {
    }
  }

  return { ensureLogFilePath, logEvent, handleViewerEvent };
}

module.exports = { createLogger };
