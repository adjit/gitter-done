const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { fetchBoard } = require('../src/github');

const POLL_MS = Number(process.env.POLL_MS) || 3 * 60 * 1000;
const WIDTH = 236;
const HEIGHT_LOADING = 148;

let win;
let shotTaken = false;
let state = { loading: true, error: null, board: null };

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT_LOADING,
    x: workArea.x + workArea.width - WIDTH - 18,
    y: workArea.y + 18,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
}

async function refresh() {
  try {
    const board = await fetchBoard();
    state = { loading: false, error: null, board };
  } catch (err) {
    state = {
      loading: false,
      error: err.message || String(err),
      board: state.board,
    };
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('state', state);
    const shotPath = process.env.GITTER_SHOT;
    if (shotPath && state.board && !shotTaken) {
      shotTaken = true;
      setTimeout(async () => {
        if (!win || win.isDestroyed()) return;
        const collapsed = await win.webContents.capturePage();
        fs.writeFileSync(shotPath, collapsed.toPNG());
        await win.webContents.executeJavaScript(
          "document.getElementById('meta').click()"
        );
        await new Promise((resolve) => setTimeout(resolve, 700));
        if (!win || win.isDestroyed()) return;
        const opened = await win.webContents.capturePage();
        fs.writeFileSync(
          shotPath.replace(/\.png$/i, '-open.png'),
          opened.toPNG()
        );
      }, 1800);
    }
  }
  return state;
}

app.whenReady().then(() => {
  createWindow();
  ipcMain.handle('state:get', () => state);
  ipcMain.handle('state:refresh', () => refresh());
  ipcMain.on('app:quit', () => app.quit());
  ipcMain.on('window:resize', (_event, height) => {
    if (!win || win.isDestroyed()) return;
    const next = Math.max(120, Math.ceil(Number(height) || HEIGHT_LOADING));
    win.setSize(WIDTH, next);
  });
  refresh();
  setInterval(refresh, POLL_MS);
});

app.on('window-all-closed', () => app.quit());
