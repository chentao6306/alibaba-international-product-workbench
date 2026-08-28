const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const APP_NAME = '\u8de8\u6613\u94fa';
const SERVER_HOST = '127.0.0.1';
let serverProcess;
let serverLog;

function choosePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, SERVER_HOST, () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function serverEntry() {
  return path.join(app.getAppPath(), 'server', 'index.js');
}

function startServer(port) {
  const dataDir = path.join(app.getPath('userData'), '.data');
  const logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  serverLog = fs.createWriteStream(path.join(logDir, 'server.log'), { flags: 'a' });
  serverProcess = spawn(process.execPath, [serverEntry()], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
      DATA_DIR: dataDir,
      NODE_ENV: 'production'
    },
    cwd: app.getAppPath(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProcess.stdout.pipe(serverLog);
  serverProcess.stderr.pipe(serverLog);
  serverProcess.on('exit', (code, signal) => {
    if (!app.isQuitting && code !== 0) console.error(`workbench server exited: ${code || signal}`);
  });
}

async function waitForServer(port, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${SERVER_HOST}:${port}/api/state`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('跨易铺本地服务启动超时，请查看用户数据目录中的 logs/server.log');
}

async function createWindow() {
  const port = await choosePort();
  startServer(port);
  await waitForServer(port);
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    title: APP_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(app.getAppPath(), 'electron', 'preload.cjs')
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  await window.loadURL(`http://${SERVER_HOST}:${port}`);
  return window;
}

app.whenReady().then(async () => {
  try {
    await createWindow();
  } catch (error) {
    console.error(error);
    app.quit();
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(() => app.quit());
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
  serverLog?.end();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
