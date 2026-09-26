// Byte overlay: a small transparent, frameless, always-on-top window that floats
// over your terminal or coding app. Only Byte, its bubble and its XP bar catch the
// mouse; everything else clicks through to the apps underneath. Drag Byte anywhere;
// right-click for the menu.
//
// Two modes:
// - App (default, and the packaged Byte.app): runs the Byte server inside this
//   process on 127.0.0.1:4317 and serves the built UI from dist/.
// - Dev (BYTE_UI_URL set, as `npm run overlay` does): loads the Vite dev UI and
//   uses the separately running `npm run dev` server.
const { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } = require('electron');
const path = require('node:path');

const DEV_UI = process.env.BYTE_UI_URL;
const PORT = Number(process.env.BYTE_PORT ?? 4317);
const UI = DEV_UI ?? `http://127.0.0.1:${PORT}/`;
const W = 196, H = 150;
/** Byte wanders at most this far either side of where you last put it. */
const WANDER = 90;
let win;
let homeX = 0;
let backend = null;   // app mode only: electron/backend.cjs
let byte = null;      // app mode only: the embedded server

/** First launch: bottom-right, just above the Dock. */
const floorY = (workArea) => workArea.y + workArea.height - H;

function startServer() {
  backend = require('./backend.cjs');
  const config = backend.readConfig();
  byte = backend.createByte({
    statePath: path.join(backend.BYTE_HOME, 'pet.json'),
    apiKey: process.env.TYPESAFE_API_KEY || config.typesafeApiKey,
    proxyUrl: backend.resolveProxy(process.env.BYTE_JEV_PROXY),
    staticDir: path.join(__dirname, '..', 'dist'),
    log: () => {},
  });
  return new Promise((resolve, reject) => {
    byte.server.once('error', reject);
    byte.server.listen(PORT, '127.0.0.1', resolve);
  });
}

const hookSource = () => path.join(__dirname, '..', 'scripts', 'byte-hook.mjs').replace('app.asar', 'app.asar.unpacked');

const RESTART_NOTE = {
  claude: 'New Claude Code sessions will show up in Byte.',
  codex: 'Restart Codex. It asks you to trust new hooks before running them: approve Byte\'s.',
  gemini: 'New Gemini CLI sessions will show up in Byte.',
};

/** Connects or disconnects agents; returns one line per agent. Never throws. */
function setHooks(agents, connect) {
  return agents.map((agent) => {
    const label = backend.agentLabel(agent);
    try {
      backend.setAgentHooks(agent, connect, hookSource(), process.execPath);
      return connect ? `${label}: connected. ${RESTART_NOTE[agent]}` : `${label}: disconnected.`;
    } catch (err) {
      return `${label}: could not update its config (${err.message}); left it untouched.`;
    }
  });
}

/**
 * A small ordinary window instead of a native modal: macOS modals stall the main
 * process, and Byte's server runs here, so hooks would time out while one is open.
 * Resolves with the index of the clicked button (-1 if closed).
 */
function ask(message, detail, buttons = ['OK']) {
  return new Promise((resolve) => {
    const w = new BrowserWindow({
      width: 440, height: 240, resizable: false, minimizable: false, title: 'Byte', alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true },
    });
    const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    const html = `<!doctype html><meta charset="utf-8"><title>Byte</title>
<body style="font:14px -apple-system,system-ui;margin:18px;color:#2c3a36;background:#fbf5e6">
<p style="font-weight:700;margin:0 0 8px">${esc(message)}</p>
<p style="white-space:pre-line;margin:0 0 14px;color:#5d6b66">${esc(detail)}</p>
<p style="text-align:right;margin:0">${buttons.map((b, i) => `<button data-i="${i}" style="margin-left:8px;padding:7px 14px;border-radius:8px;border:0;font-weight:600;${i === 0 ? 'background:#3e9d78;color:#fff' : 'background:#e6dcc2;color:#2c3a36'}">${esc(b)}</button>`).join('')}</p>
<script>document.querySelectorAll('button').forEach((b)=>b.onclick=()=>window.byteHost.answer(Number(b.dataset.i)));</script>`;
    let done = false;
    const finish = (i) => { if (!done) { done = true; resolve(i); if (!w.isDestroyed()) w.close(); } };
    const onAnswer = (e, i) => { if (e.sender === w.webContents) { ipcMain.removeListener('byte:answer', onAnswer); finish(i); } };
    ipcMain.on('byte:answer', onAnswer);
    w.on('closed', () => { ipcMain.removeListener('byte:answer', onAnswer); finish(-1); });
    w.setMenu(null);
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
}

function showResult(lines) {
  void ask('Byte', lines.join('\n\n'));
}

async function firstRun() {
  const config = backend.readConfig();
  const found = backend.AGENT_IDS.filter((a) => backend.agentPresent(a) && !backend.hooksInstalled(a));
  if (config.askedToConnect || found.length === 0) return;
  const names = found.map(backend.agentLabel).join(', ');
  backend.writeConfig({ ...backend.readConfig(), askedToConnect: true });
  const response = await ask(`Connect Byte to ${names}?`,
    'Byte adds small hooks to each agent\'s settings (a backup is kept) so it can react to your coding sessions. They never block or change what the agent does. You can connect or disconnect each agent from the right-click menu at any time.',
    ['Connect', 'Not now']);
  if (response === 0) showResult(setHooks(found, true));
}

function keyWindow() {
  const kw = new BrowserWindow({
    width: 420, height: 210, resizable: false, minimizable: false, title: 'Jev API key',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true },
  });
  const html = `<!doctype html><meta charset="utf-8"><title>Jev API key</title>
<body style="font:14px -apple-system,system-ui;margin:18px;color:#2c3a36;background:#fbf5e6">
<p style="margin:0 0 10px">Optional. Byte already uses a shared <b>Jev</b> service. Paste your own TypeSafe API key to call Jev directly instead. It is stored only on this Mac, in ~/.byte/config.json. Leave empty to go back to the shared service.</p>
<form id="f"><input id="k" type="password" placeholder="TypeSafe API key" autofocus style="width:100%;padding:8px;box-sizing:border-box;border:1px solid #cdbf9c;border-radius:8px">
<p style="text-align:right;margin:12px 0 0"><button type="submit" style="padding:7px 14px;border-radius:8px;border:0;background:#3e9d78;color:#fff;font-weight:600">Save</button></p></form>
<script>document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();await window.byteHost.saveKey(document.getElementById('k').value.trim());window.close();};</script>`;
  kw.setMenu(null);
  kw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

ipcMain.handle('byte:saveKey', (_e, key) => {
  if (!backend) return;
  backend.writeConfig({ ...backend.readConfig(), typesafeApiKey: key || undefined });
  byte.setApiKey(key || undefined);
});

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
    const agentItems = backend ? backend.AGENT_IDS.filter(backend.agentPresent).map((agent) => {
      const label = backend.agentLabel(agent);
      return backend.hooksInstalled(agent)
        ? { label: `Disconnect ${label}`, click: () => showResult(setHooks([agent], false)) }
        : { label: `Connect ${label}`, click: () => showResult(setHooks([agent], true)) };
    }) : [];
    const appItems = backend ? [
      { type: 'separator' },
      ...agentItems,
      { label: 'Use my own Jev API key…', click: keyWindow },
    ] : [];
    const send = (cmd) => () => win.webContents.send('byte:command', cmd);
    const petMenu = [['dragon', 'Mint dragon'], ['fire', 'Fire dragon'], ['cat', 'Wizard cat'], ['robot', 'Robot']]
      .map(([id, label]) => ({ label, click: send(`species:${id}`) }));
    const colorMenu = ['original', 'mint', 'sky', 'lavender', 'rose', 'ember', 'gold']
      .map((c) => ({ label: c[0].toUpperCase() + c.slice(1), click: send(`color:${c}`) }));
    Menu.buildFromTemplate([
      { label: 'Pet', submenu: petMenu },
      { label: 'Color', submenu: colorMenu },
      { type: 'separator' },
      { label: 'Open full view', click: () => shell.openExternal(UI) },
      { label: 'Replay demo / exit demo', click: () => win.webContents.send('byte:command', 'replay') },
      { label: 'Stop following this session', click: () => win.webContents.send('byte:command', 'disconnect') },
      ...appItems,
      { type: 'separator' },
      { label: 'Quit Byte', click: () => app.quit() },
    ]).popup({ window: win });
  });
}

ipcMain.on('byte:openFull', () => { void shell.openExternal(`${UI}#gallery`); });

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
if (!app.requestSingleInstanceLock()) app.quit();
app.whenReady().then(async () => {
  if (!DEV_UI) {
    try {
      await startServer();
    } catch (err) {
      dialog.showErrorBox('Byte could not start', err.code === 'EADDRINUSE'
        ? `Port ${PORT} is already in use. Is another Byte (or \`npm run dev\`) running?`
        : String(err.message ?? err));
      app.quit();
      return;
    }
  }
  create();
  if (!DEV_UI) void firstRun();
});
app.on('window-all-closed', () => { if (!win || win.isDestroyed()) app.quit(); });
app.on('before-quit', () => { void byte?.close(); });
