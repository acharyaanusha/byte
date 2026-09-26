const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('byteHost', {
  moveBy: (dx) => ipcRenderer.invoke('byte:moveBy', dx),
  onCommand: (cb) => ipcRenderer.on('byte:command', (_e, cmd) => cb(cmd)),
  setInteractive: (on) => ipcRenderer.send('byte:interactive', on),
  dragStart: () => ipcRenderer.send('byte:dragStart'),
  dragMove: (dx, dy) => ipcRenderer.send('byte:dragMove', dx, dy),
  dragEnd: () => ipcRenderer.send('byte:dragEnd'),
  saveKey: (key) => ipcRenderer.invoke('byte:saveKey', key),
  answer: (i) => ipcRenderer.send('byte:answer', i),
});
