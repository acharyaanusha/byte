// Byte overlay: a small transparent, frameless, always-on-top window that floats
// over your terminal or coding app. It loads the same UI in ?overlay mode.
// Only Byte, its bubble and its XP bar catch the mouse; everything else clicks
// through to the apps underneath. Drag Byte anywhere; right-click for the menu.
const { app, BrowserWindow, ipcMain, Menu, screen, shell } = require('electron');
const path = require('node:path');

const UI = process.env.BYTE_UI_URL ?? 'http://127.0.0.1:5173/';
const W = 196, H = 150;
/** Byte wanders at most this far either side of where you last put it. */
const WANDER = 90;
let win;
let homeX = 0;

/** First launch: bottom-right, just above the Dock. */
const floorY = (workArea) => workArea.y + workArea.height - H;

function create() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: W, height: H,
    x: workArea.x + workArea.width - W - 24,
    y: floorY(workArea),
    frame: false, transparent: true, resizable: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, fullscreenable: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true },
  });
  // Stay above full-screen apps and follow you across Spaces.
  homeX = win.getPosition()[0];
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Click-through by default; the page turns mouse capture on while the pointer is over Byte.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadURL(`${UI}?overlay=1`);
  win.webContents.on('context-menu', () => {
    Menu.buildFromTemplate([
      { label: 'Open full view', click: () => shell.openExternal(UI) },
      { label: 'Replay demo / exit demo', click: () => win.webContents.send('byte:command', 'replay') },
      { label: 'Disconnect from this Claude session', click: () => win.webContents.send('byte:command', 'disconnect') },
      { type: 'separator' },
      { label: 'Quit Byte overlay', click: () => app.quit() },
    ]).popup({ window: win });
  });
}

ipcMain.on('byte:interactive', (_e, on) => {
  if (win) win.setIgnoreMouseEvents(!on, { forward: true });
});

// Dragging: the page reports the pointer's total offset since drag start.
let dragOrigin = null;
ipcMain.on('byte:dragStart', () => { if (win) dragOrigin = win.getPosition(); });
ipcMain.on('byte:dragMove', (_e, dx, dy) => {
  if (win && dragOrigin) win.setPosition(Math.round(dragOrigin[0] + dx), Math.round(dragOrigin[1] + dy));
});
ipcMain.on('byte:dragEnd', () => {
  dragOrigin = null;
  if (win) homeX = win.getPosition()[0]; // Byte stays where you put it and wanders around that spot
});

// Walking: move the window horizontally, within WANDER of home and on screen.
ipcMain.handle('byte:moveBy', (_e, dx) => {
  if (!win || dragOrigin) return { hitEdge: false };
  const [x, y] = win.getPosition();
  const { workArea } = screen.getDisplayMatching(win.getBounds());
  const min = Math.max(workArea.x, homeX - WANDER);
  const max = Math.min(workArea.x + workArea.width - W, homeX + WANDER);
  const nx = Math.max(min, Math.min(max, x + Math.round(dx)));
  win.setPosition(nx, y);
  return { hitEdge: nx === min || nx === max };
});

if (process.platform === 'darwin') app.dock?.hide();
app.whenReady().then(create);
app.on('window-all-closed', () => app.quit());
