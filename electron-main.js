const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs/promises');
const path = require('path');

let port;
const root = __dirname;
let server;
let runtimeDir;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const finder = net.createServer();
    finder.unref();
    finder.on('error', reject);
    finder.listen(0, '127.0.0.1', () => {
      const { port: freePort } = finder.address();
      finder.close(error => error ? reject(error) : resolve(freePort));
    });
  });
}

function waitForServer(attempt = 0) {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://localhost:${port}`, response => {
      response.resume();
      resolve();
    });
    request.on('error', () => {
      if (attempt >= 40) return reject(new Error('The local video server did not start.'));
      setTimeout(() => waitForServer(attempt + 1).then(resolve).catch(reject), 250);
    });
    request.setTimeout(500, () => request.destroy());
  });
}

function uniquePath(folder, name) {
  const extension = path.extname(name);
  const base = path.basename(name, extension);
  return (async () => {
    for (let index = 0; ; index += 1) {
      const candidate = path.join(folder, index ? `${base} (${index})${extension}` : name);
      try { await fs.access(candidate); } catch (_) { return candidate; }
    }
  })();
}

ipcMain.handle('save-cut-files', async (_event, sourcePath, files) => {
  const folder = path.dirname(sourcePath);
  const saved = [];
  for (const file of files) {
    const from = path.join(runtimeDir, 'outputs', file.storedName);
    const to = await uniquePath(folder, file.name);
    await fs.copyFile(from, to);
    saved.push(to);
  }
  return saved;
});
ipcMain.handle('open-source-folder', (_event, sourcePath) => shell.openPath(path.dirname(sourcePath)));

async function start() {
  // A new port on each launch prevents an old background server from being reused.
  port = await getFreePort();
  runtimeDir = path.join(app.getPath('userData'), 'runtime');
  // app.getPath('exe') remains correct after a portable EXE extracts to a temp folder.
  server = spawn(app.getPath('exe'), [path.join(root, 'server.js')], {
    // In a packaged app root is app.asar (a file), not a working directory.
    cwd: app.isPackaged ? process.resourcesPath : root,
    env: { ...process.env, PORT: String(port), P_TWO7_DATA_DIR: runtimeDir, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true
  });
  const window = new BrowserWindow({ width: 1120, height: 850, minWidth: 760, webPreferences: { preload: path.join(root, 'preload.js'), contextIsolation: true } });
  try {
    await waitForServer();
    await window.loadURL(`http://localhost:${port}`);
  } catch (error) {
    await window.loadURL(`data:text/html,<h2>Could not start Clip Candy</h2><p>${encodeURIComponent(error.message)}</p>`);
  }
}

app.whenReady().then(start);
app.on('window-all-closed', () => app.quit());
app.on('quit', () => server?.kill());
