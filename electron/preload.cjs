const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picoHost', {
  moveBy: (dx) => ipcRenderer.invoke('pico:moveBy', dx),
  onCommand: (cb) => ipcRenderer.on('pico:command', (_e, cmd) => cb(cmd)),
  setInteractive: (on) => ipcRenderer.send('pico:interactive', on),
  dragStart: () => ipcRenderer.send('pico:dragStart'),
  dragMove: (dx, dy) => ipcRenderer.send('pico:dragMove', dx, dy),
  dragEnd: () => ipcRenderer.send('pico:dragEnd'),
  saveKey: (key) => ipcRenderer.invoke('pico:saveKey', key),
  answer: (i) => ipcRenderer.send('pico:answer', i),
  openFullView: () => ipcRenderer.send('pico:openFull'),
});
