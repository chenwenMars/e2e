// The Electron testbed's main process: one sign-in window, a settings window
// it opens on request, and IPC the renderer reaches through the preload
// script, so a test proves the engine drives the app as it really starts.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

/** What the main process saw, read back by tests through `electron.evaluate`. */
const state = { signIns: [], settingsOpened: 0 };
globalThis.testbedState = state;

/** `--greeting=<text>` from the launch arguments, shown in the window's heading. */
function greeting() {
  const flag = process.argv.find((argument) => argument.startsWith('--greeting='));
  return flag === undefined ? 'Welcome' : flag.slice('--greeting='.length);
}

function createWindow(page, options) {
  const window = new BrowserWindow({
    width: 640,
    height: 720,
    show: process.env.E2E_ELECTRON_HIDDEN !== '1',
    ...options,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void window.loadFile(path.join(__dirname, page));
  return window;
}

ipcMain.handle('testbed:greeting', () => greeting());
ipcMain.handle('testbed:sign-in', (_event, { username, password, plan, remember }) => {
  if (password.length === 0) return { ok: false, message: 'Password is required' };
  state.signIns.push({ username, plan, remember });
  return {
    ok: true,
    message: `Signed in as ${username} on ${plan}${remember ? ', remembered' : ''} (main process saw ${password.length} characters)`,
  };
});
ipcMain.handle('testbed:open-settings', () => {
  state.settingsOpened += 1;
  createWindow('settings.html', { width: 420, height: 360, title: 'Settings' });
});
ipcMain.handle('testbed:user-data', () => app.getPath('userData'));

/** Loads another page of the app into the first window, for tests of controls the sign-in form does not have. */
globalThis.testbedOpen = (page) => BrowserWindow.getAllWindows()[0].loadFile(path.join(__dirname, page));

/** Marks that the app ran its quit handlers, which a window's beforeunload guard must not stop. */
app.on('will-quit', () => {
  require('node:fs').writeFileSync(path.join(app.getPath('userData'), 'quit-handled'), '1');
});

app.whenReady().then(() => {
  createWindow('index.html', { title: 'Sign In' });
});

app.on('window-all-closed', () => app.quit());
