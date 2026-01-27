const fs = require('node:fs');
const path = require('node:path');
const Store = require('electron-store');

function createStore({
  portable,
  portableStoreCwd,
  encryptionKey,
}) {
  if (portable && !fs.existsSync(portableStoreCwd)) {
    fs.mkdirSync(portableStoreCwd);
  }

  const store = portable
    ? new Store({ name: 'storage', fileExtension: 'db', cwd: portableStoreCwd, encryptionKey: encryptionKey })
    : new Store();

  return store;
}

module.exports = { createStore };
