const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const APP_NAME = '\u8de8\u6613\u94fa';
const SERVER_HOST = '127.0.0.1';
let serverProcess;
let serverLog;
let bridgeSecret;
let loginWindow;

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  const updateUrl = String(process.env.CROSS_EASYSHOP_UPDATE_URL || '').trim();
  if (!updateUrl) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.setFeedURL({ provider: 'generic', url: updateUrl });
    autoUpdater.checkForUpdatesAndNotify().catch((error) => console.warn('[updater]', error.message));
  } catch (error) {
    console.warn('[updater] unavailable:', error.message);
  }
}

function deviceId() {
  return crypto.createHash('sha256').update(`${app.getPath('userData')}|cross-easyshop`).digest('hex').slice(0, 32);
}

function bridgeToken(account) {
  const stamp = String(Date.now());
  const payload = `${String(account || '').trim().toLowerCase()}|${stamp}|${deviceId()}`;
  const signature = crypto.createHmac('sha256', bridgeSecret).update(payload).digest('hex');
  return `${stamp}.${signature}`;
}

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
      CROSS_EASYSHOP_BRIDGE_SECRET: bridgeSecret,
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

function looksLoggedIn(url, text) {
  const currentUrl = String(url || '').toLowerCase();
  const body = String(text || '').toLowerCase();
  if (/login|signin|sign-in|passport/.test(currentUrl)) return false;
  return /my alibaba|seller center|seller backend|卖家后台|国际站卖家|manage products|product management/.test(body);
}

async function inspectAlibabaPage(contents) {
  return contents.executeJavaScript(`({ url: location.href, text: (document.body && document.body.innerText) || '' })`, true);
}

async function alibabaLogin({ account, password }) {
  const normalizedAccount = String(account || '').trim();
  const secret = String(password || '');
  if (!normalizedAccount || !secret) throw new Error('请输入阿里巴巴国际站账号和密码');
  if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
  loginWindow = new BrowserWindow({
    width: 1500,
    height: 1000,
    title: `${APP_NAME} - 阿里巴巴国际站登录`,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: `persist:cross-easyshop-${deviceId()}`
    }
  });
  loginWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  const closePromise = new Promise((resolve) => loginWindow.once('closed', () => resolve({ closed: true })));
  await loginWindow.loadURL('https://passport.alibaba.com/icbu_login.htm');
  let filled = false;
  const fillScript = `(() => {
    const account = ${JSON.stringify(normalizedAccount)};
    const password = ${JSON.stringify(secret)};
    const fields = [...document.querySelectorAll('input')];
    const accountField = fields.find((el) => /email|account|username|login|账号|邮箱/i.test((el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || ''))) || fields.find((el) => /text|email|tel/i.test(el.type || '') && !el.disabled);
    const passwordField = fields.find((el) => el.type === 'password' || /password|密码/i.test((el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || '')));
    const setValue = (el, value) => { if (!el) return; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; setter?.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    setValue(accountField, account); setValue(passwordField, password);
    const button = [...document.querySelectorAll('button, input[type="submit"], a')].find((el) => /sign in|login|登录|登 录/i.test((el.innerText || el.value || '').trim()));
    if (button) button.click(); else passwordField?.form?.requestSubmit?.();
    return Boolean(accountField && passwordField);
  })()`;
  const fillDeadline = Date.now() + 15000;
  while (Date.now() < fillDeadline && !filled) {
    if (!loginWindow || loginWindow.isDestroyed()) throw new Error('登录窗口已关闭，未完成阿里巴巴国际站登录');
    filled = await loginWindow.webContents.executeJavaScript(fillScript, true).catch(() => false);
    if (!filled) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!filled) throw new Error('未识别到阿里巴巴国际站登录表单，请确认登录页面已加载');

  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (!loginWindow || loginWindow.isDestroyed()) throw new Error('登录窗口已关闭，未完成阿里巴巴国际站登录');
    const result = await inspectAlibabaPage(loginWindow.webContents).catch(() => ({ url: '', text: '' }));
    if (looksLoggedIn(result.url, result.text)) {
      const token = bridgeToken(normalizedAccount);
      loginWindow.hide();
      return { account: normalizedAccount, bridgeToken: token };
    }
    await Promise.race([new Promise((resolve) => setTimeout(resolve, 1000)), closePromise]);
  }
  throw new Error('阿里巴巴国际站登录超时，请检查账号密码或完成页面验证码');
}

async function waitForServer(port, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${SERVER_HOST}:${port}/api/health`);
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
  bridgeSecret = process.env.CROSS_EASYSHOP_BRIDGE_SECRET || crypto.randomBytes(32).toString('hex');
  ipcMain.handle('auth:alibaba-login', (_event, payload) => alibabaLogin(payload || {}));
  ipcMain.handle('app:quit', () => app.quit());
  try {
    await createWindow();
    setupAutoUpdate();
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
