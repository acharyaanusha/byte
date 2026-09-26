const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('byteHost', {
  moveBy: (dx) => ipcRenderer.invoke('byte:moveBy', dx),
  onCommand: (cb) => ipcRenderer.on('byte:command', (_e, cmd) => cb(cmd)),
});
