// Byte overlay: a small transparent, frameless, always-on-top window that floats
// over your terminal or coding app. It loads the same UI in ?overlay mode.
// Only Byte, its bubble and its XP bar catch the mouse; everything else clicks
// through to the apps underneath. Drag Byte anywhere; right-click for the menu.
const { app, BrowserWindow, ipcMain, Menu, screen, shell } = require('electron');
const path = require('node:path');

const UI = process.env.BYTE_UI_URL ?? 'http://127.0.0.1:5173/';
const W = 260, H = 250;
let win;

/** Byte stands on the bottom of the work area, just above the Dock. */
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
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Click-through by default; the page turns mouse capture on while the pointer is over Byte.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadURL(`${UI}?overlay=1`);
  win.webContents.on('context-menu', () => {
    Menu.buildFromTemplate([
      { label: 'Open full view', click: () => shell.openExternal(UI) },
      { label: 'Replay demo / exit demo', click: () => win.webContents.send('byte:command', 'replay') },
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
ipcMain.on('byte:dragEnd', () => { dragOrigin = null; fall(); });

// Gravity: let go mid-air and Byte drops back to the floor with a small bounce.
let falling = null;
function fall() {
  if (!win || falling) return;
  const { workArea } = screen.getDisplayMatching(win.getBounds());
  const floor = floorY(workArea);
  let [x, y] = win.getPosition();
  if (y >= floor - 1) { win.setPosition(x, Math.min(y, floor)); return; }
  let vy = 0, bounced = false;
  win.webContents.send('byte:command', 'fall-start');
  falling = setInterval(() => {
    vy += 1.6;                      // px per frame², ~60 fps
    y += vy;
    if (y >= floor) {
      y = floor;
      if (!bounced && vy > 8) { vy = -vy * 0.3; bounced = true; }
      else {
        clearInterval(falling); falling = null;
        win.webContents.send('byte:command', 'fall-end');
      }
    }
    [x] = win.getPosition();
    win.setPosition(x, Math.round(y));
  }, 16);
}

// Walking: move the window horizontally, clamped to the display it is on.
ipcMain.handle('byte:moveBy', (_e, dx) => {
  if (!win || dragOrigin || falling) return { hitEdge: false, toCenter: 0 };
  const [x, y] = win.getPosition();
  const { workArea } = screen.getDisplayMatching(win.getBounds());
  const min = workArea.x, max = workArea.x + workArea.width - W;
  const nx = Math.max(min, Math.min(max, x + Math.round(dx)));
  win.setPosition(nx, y);
  const center = workArea.x + (workArea.width - W) / 2;
  return { hitEdge: nx === min || nx === max, toCenter: Math.round(center - nx) };
});

if (process.platform === 'darwin') app.dock?.hide();
app.whenReady().then(create);
app.on('window-all-closed', () => app.quit());
