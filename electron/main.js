import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const localPort = Number(process.env.KUA_YIPU_PORT || 8787);
// The IP fallback keeps the server-only rollout usable; replace it with the HTTPS domain before public sales.
const authBaseUrl = String(process.env.KUA_YIPU_AUTH_URL || 'http://106.55.45.126').replace(/\/$/, '');
let serverModulePromise;
let localServerPromise;
let loginWindow;
let mainWindow;
let alibabaWindow;
const alibabaWindows = new Set();
const registeredAlibabaWindows = new WeakSet();
let currentSession = null;
let enterSystemPromise = null;
const localGate = crypto.randomBytes(32).toString('hex');
let hasSingleInstanceLock = false;

function alibabaCookiesFile() {
  return path.join(app.getPath('userData'), 'alibaba-cookies.json');
}

async function saveAlibabaCookies(login) {
  try {
    const cookies = await login.webContents.session.cookies.get({});
    fs.mkdirSync(path.dirname(alibabaCookiesFile()), { recursive: true });
    fs.writeFileSync(alibabaCookiesFile(), JSON.stringify(cookies), { mode: 0o600 });
  } catch {
    // Cookie synchronization is best-effort; Alibaba may still expose public
    // listing data when the session cannot be exported.
  }
}

function credentialFile() {
  return path.join(app.getPath('userData'), 'credentials.bin');
}

function loadCredentials() {
  try {
    const encrypted = fs.readFileSync(credentialFile());
    if (!safeStorage.isEncryptionAvailable()) return null;
    return JSON.parse(safeStorage.decryptString(encrypted));
  } catch { return null; }
}

function saveCredentials(credentials) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('当前 Windows 环境不支持安全凭据存储');
  fs.mkdirSync(path.dirname(credentialFile()), { recursive: true });
  fs.writeFileSync(credentialFile(), safeStorage.encryptString(JSON.stringify(credentials)));
}

function clearCredentials() {
  fs.rmSync(credentialFile(), { force: true });
}

async function authRequest(endpoint, body, token = '') {
  if (!authBaseUrl) throw new Error('登录失败');
  let response;
  try {
    response = await fetch(`${authBaseUrl}${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body)
    });
  } catch {
    throw new Error('登录失败');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('登录失败');
  return data;
}

const isWindowAlive = (window) => Boolean(window && !window.isDestroyed() && window.webContents && !window.webContents.isDestroyed());

function isAlibabaProductPostingUrl(value) {
  try {
    const hostname = new URL(String(value || '')).hostname.toLowerCase();
    return hostname === 'post.alibaba.com' || /(?:^|-)productposting\.alibaba\.com$/.test(hostname);
  } catch {
    return false;
  }
}

function liveAlibabaWindows() {
  for (const window of alibabaWindows) {
    if (!isWindowAlive(window)) alibabaWindows.delete(window);
  }
  return [...alibabaWindows];
}

function currentAlibabaWindow({ preferPosting = false } = {}) {
  const windows = liveAlibabaWindows();
  if (preferPosting) {
    const posting = [...windows].reverse().find((window) => isAlibabaProductPostingUrl(window.webContents.getURL()));
    if (posting) return posting;
  }
  if (isWindowAlive(alibabaWindow)) return alibabaWindow;
  return windows.at(-1) || null;
}

function registerAlibabaWindow(window) {
  if (!isWindowAlive(window)) return window;
  alibabaWindows.add(window);
  if (registeredAlibabaWindows.has(window)) return window;
  registeredAlibabaWindows.add(window);

  window.on('focus', () => { if (isWindowAlive(window)) alibabaWindow = window; });
  window.webContents.on('did-create-window', (child) => {
    registerAlibabaWindow(child);
    alibabaWindow = child;
  });
  // Alibaba installs beforeunload handlers on some pages. Native close must
  // still destroy the selected browser window immediately.
  window.on('close', (event) => {
    if (window.isDestroyed()) return;
    event.preventDefault();
    window.destroy();
  });
  window.on('closed', () => {
    alibabaWindows.delete(window);
    if (alibabaWindow === window) alibabaWindow = liveAlibabaWindows().at(-1) || null;
  });
  return window;
}

function createLoginWindow() {
  loginWindow = new BrowserWindow({ width: 520, height: 620, resizable: false, show: false, title: '跨易铺登录', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false } });
  loginWindow.once('ready-to-show', () => loginWindow?.show());
  const loginFile = path.join(__dirname, 'login.html');
  const loginUrl = pathToFileURL(loginFile).href;
  const loadLogin = async (attempt = 0) => {
    try {
      if (!fs.existsSync(loginFile)) throw new Error('登录页面文件不存在');
      await loginWindow.loadURL(loginUrl);
    } catch (error) {
      if (attempt < 2 && isWindowAlive(loginWindow)) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        return loadLogin(attempt + 1);
      }
      dialog.showErrorBox('跨易铺启动失败', `登录界面加载失败：${error.message}`);
    }
  };
  loadLogin();
  loginWindow.on('closed', () => { loginWindow = null; if (!mainWindow) app.quit(); });
}

function mainWindowUrl() {
  return `http://127.0.0.1:${localPort}/`;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForWorkbenchRender(window) {
  let lastState = '';
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (!isWindowAlive(window)) throw new Error('工作台窗口已关闭');
    const state = await window.webContents.executeJavaScript(`(() => {
      const root = document.getElementById('root');
      return { ready: document.readyState, children: root?.childElementCount || 0, title: document.title || '' };
    })()`, true).catch((error) => ({ error: error.message }));
    if (state?.children > 0) return state;
    lastState = state?.error || `${state?.ready || 'unknown'}:${state?.children || 0}`;
    await wait(125);
  }
  throw new Error(`工作台页面未完成渲染（${lastState || '无页面内容'}）`);
}

async function loadWorkbench(window) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!isWindowAlive(window)) throw new Error('工作台窗口已关闭');
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => finish(new Error('工作台页面加载超时，请点击重试')),
          15000);
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          window.webContents.removeListener('did-finish-load', onFinish);
          window.webContents.removeListener('did-fail-load', onFail);
          window.webContents.removeListener('render-process-gone', onGone);
          error ? reject(error) : resolve();
        };
        const onFinish = () => {
          // The startup placeholder is loaded in the same window first. Its
          // did-finish-load event must not satisfy the workbench navigation.
          if (window.webContents.getURL() !== mainWindowUrl()) return;
          finish();
        };
        const onFail = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
          if (isMainFrame === false) return;
          if (validatedURL && validatedURL !== mainWindowUrl()) return;
          // Replacing the startup placeholder with the local workbench emits
          // ERR_ABORTED for the navigation that was just superseded. That is
          // expected and must not turn a successful load into an error page.
          if (errorCode === -3) return;
          finish(new Error(`工作台页面加载失败（${errorCode}: ${errorDescription || validatedURL}）`));
        };
        const onGone = (_event, details) => finish(new Error(`工作台渲染进程异常退出（${details?.reason || 'unknown'}）`));
        window.webContents.once('did-finish-load', onFinish);
        window.webContents.once('did-fail-load', onFail);
        window.webContents.once('render-process-gone', onGone);
        window.loadURL(mainWindowUrl()).catch(finish);
      });
      return await waitForWorkbenchRender(window);
    } catch (error) {
      lastError = error;
      if (attempt < 2 && isWindowAlive(window)) await wait(350 * (attempt + 1));
    }
  }
  throw lastError || new Error('工作台页面加载失败');
}

function showWorkbenchError(window, error) {
  if (!isWindowAlive(window)) return;
  const message = String(error?.message || '工作台页面加载失败').replace(/[<>&"']/g, (value) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[value]));
  const retryUrl = mainWindowUrl();
  const html = `<!doctype html><meta charset="utf-8"><title>跨易铺启动失败</title><style>body{font-family:Microsoft YaHei,sans-serif;margin:0;background:#f4f6f7;color:#182028;display:grid;place-items:center;height:100vh}.box{background:#fff;border:1px solid #dfe4e7;border-radius:8px;padding:32px 38px;box-shadow:0 8px 26px #18202822;max-width:620px}h1{font-size:22px;margin:0 0 12px;color:#f06423}p{line-height:1.7;color:#59666c;word-break:break-word}button{height:40px;padding:0 22px;border:0;border-radius:5px;background:#f06423;color:#fff;font-weight:700;cursor:pointer}</style><main class="box"><h1>工作台暂时未能打开</h1><p>${message}</p><button onclick="location.href=${JSON.stringify(retryUrl)}">重新加载</button></main>`;
  window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
}

function workbenchLoadingUrl() {
  const html = '<!doctype html><meta charset="utf-8"><title>跨易铺</title><style>body{font-family:Microsoft YaHei,sans-serif;margin:0;background:#f4f6f7;color:#59666c;display:grid;place-items:center;height:100vh}.box{text-align:center}.spinner{width:28px;height:28px;border:3px solid #dfe4e7;border-top-color:#f06423;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 16px}@keyframes spin{to{transform:rotate(360deg)}}</style><main class="box"><div class="spinner"></div><div>正在启动工作台，请稍候…</div></main>';
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({ width: 1440, height: 960, minWidth: 1100, minHeight: 720, title: '跨易铺', autoHideMenuBar: true, show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false } });
  const window = mainWindow;
  window.webContents.session.webRequest.onBeforeSendHeaders({ urls: [`http://127.0.0.1:${localPort}/api/*`] }, (details, callback) => {
    details.requestHeaders['X-Kua-Yipu-Gate'] = localGate;
    callback({ requestHeaders: details.requestHeaders });
  });
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) console.error(`工作台渲染错误 ${sourceId}:${line} ${message}`);
  });
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
  // Do not make the Alibaba login button wait for renderer lifecycle events.
  // Electron can delay did-finish-load while the page is already usable; the
  // workbench is shown immediately and the load is supervised in the background.
  window.show();
  window.focus();
  await window.loadURL(workbenchLoadingUrl());
  const startupTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('本地工作台服务启动超时，请重试')), 15000));
  Promise.race([ensureLocalServer(), startupTimeout])
    .then(() => loadWorkbench(window))
    .catch((error) => showWorkbenchError(window, error));
  return window;
}

async function ensureAlibabaSellerWindow() {
  const existing = currentAlibabaWindow({ preferPosting: true });
  if (isWindowAlive(existing)) return existing;
  const username = currentSession?.username;
  if (!username) throw new Error('登录失败');
  const seller = new BrowserWindow({
    width: 1440,
    height: 960,
    show: true,
    title: 'Alibaba.com 卖家后台',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: `persist:kua-yipu-${username}`
    }
  });
  registerAlibabaWindow(seller);
  alibabaWindow = seller;
  // Reveal the browser before starting navigation. Alibaba can leave the
  // request pending during redirects or verification; waiting for loadURL
  // first made the button look broken and hid the CAPTCHA from the user.
  seller.show();
  seller.maximize();
  seller.focus();
  await Promise.race([
    seller.loadURL('https://i.alibaba.com/'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('My Alibaba 页面加载超时，请在已打开的浏览器中检查登录或验证码')), 45000))
  ]);
  return seller;
}

async function showAlibabaSellerWindow() {
  // Reuse the authenticated Alibaba session, including any tracked child
  // window, before creating another browser profile.
  const seller = await ensureAlibabaSellerWindow();
  seller.show();
  if (seller.isMinimized()) seller.restore();
  seller.maximize();
  seller.focus();
  const currentUrl = seller.webContents.getURL();
  let hostname = '';
  try { hostname = new URL(currentUrl).hostname.toLowerCase(); } catch {}
  const isSellerPage = hostname === 'i.alibaba.com' || isAlibabaProductPostingUrl(currentUrl);
  if (!isSellerPage) {
    await Promise.race([
      seller.loadURL('https://i.alibaba.com/'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('My Alibaba 页面加载超时，请在已打开的浏览器中检查登录或验证码')), 45000))
    ]);
  }
  await saveAlibabaCookies(seller);
  return { browserOpen: true, visible: true, currentUrl: seller.webContents.getURL(), onAlibabaInternational: true };
}

async function inspectAndHideAlibabaSellerWindow() {
  const windows = liveAlibabaWindows();
  if (!windows.length) return null;
  let postingPage = null;
  try {
    for (const seller of [...windows].reverse()) {
      const details = await seller.webContents.executeJavaScript(`(() => {
        const title = document.title || '';
        const body = document.body?.innerText || '';
        const titleField = document.querySelector('input[name="productTitle"], input[placeholder*="商品标题"], input[placeholder*="标题"], input[placeholder*="product title" i], input[placeholder*="product name" i], textarea[placeholder*="标题"], textarea[placeholder*="title" i]');
        const category = body.match(/当前类目：\\s*([^\\n]+)/)?.[1]?.trim() || '';
        return { url: location.href, title, category, hasTitleField: Boolean(titleField) };
      })()`, true).catch(() => null);
      if (!details || !isAlibabaProductPostingUrl(details.url)) continue;
      postingPage ||= { seller, details };
      if (details.hasTitleField) {
        postingPage = { seller, details };
        break;
      }
    }
    if (!postingPage) throw new Error('当前不是国际站商品发布页，请进入 Products → Post Products 并打开商品填写表单');
    if (!postingPage.details.hasTitleField) throw new Error('请先完成类目选择并打开商品填写表单后再绑定');
    alibabaWindow = postingPage.seller;
    await saveAlibabaCookies(postingPage.seller);
    return { url: postingPage.details.url, title: postingPage.details.title, category: postingPage.details.category };
  } finally {
    for (const window of liveAlibabaWindows()) window.hide();
  }
}

async function enterSystem() {
  if (!currentSession) throw new Error('登录失败');
  // Switch windows immediately. Server startup, cookie export, and renderer
  // loading are supervised in the background so the Alibaba page can never be
  // held in an endless "正在进入" state.
  const seller = currentAlibabaWindow();
  if (isWindowAlive(seller)) saveAlibabaCookies(seller).catch(() => {});
  if (isWindowAlive(mainWindow)) {
    mainWindow.show();
    mainWindow.focus();
    const startupTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('本地工作台服务启动超时，请重试')), 15000));
    Promise.race([ensureLocalServer(), startupTimeout]).then(() => loadWorkbench(mainWindow)).catch((error) => showWorkbenchError(mainWindow, error));
  } else {
    createMainWindow().catch((error) => showWorkbenchError(mainWindow, error));
  }
  for (const window of liveAlibabaWindows()) window.hide();
  if (isWindowAlive(loginWindow)) loginWindow.close();
  return true;
}

function enterSystemOnce() {
  if (!enterSystemPromise) {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('进入工作台超时，请重试')), 20000));
    enterSystemPromise = Promise.race([enterSystem(), timeout]).finally(() => { enterSystemPromise = null; });
  }
  return enterSystemPromise;
}

function ensureLocalServer() {
  if (!localServerPromise) {
    localServerPromise = startLocalServer().catch((error) => {
      localServerPromise = null;
      throw error;
    });
  }
  return localServerPromise;
}

async function startLocalServer() {
  const packagedEntry = path.join(process.resourcesPath || rootDir, 'app.asar.unpacked', 'server', 'index.js');
  const entry = app.isPackaged && fs.existsSync(packagedEntry) ? packagedEntry : path.join(rootDir, 'server', 'index.js');
  const dataDir = path.join(app.getPath('userData'), '.data');
  process.env.PORT = String(localPort);
  process.env.DATA_DIR = dataDir;
  process.env.KUA_YIPU_DESKTOP = '1';
  process.env.KUA_YIPU_LOCAL_GATE = localGate;
  // A packaged client must use the Chromium shipped in resources/chromium.
  // Development builds may still use the local Playwright cache.
  process.env.KUA_YIPU_REQUIRE_BUNDLED_BROWSER = app.isPackaged ? '1' : '0';
  process.env.APP_ROOT_DIR = app.isPackaged ? app.getAppPath() : rootDir;
  process.env.KUA_YIPU_DIST_DIR = path.join(process.env.APP_ROOT_DIR, 'dist');
  process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = alibabaCookiesFile();
  serverModulePromise ||= import(pathToFileURL(entry).href);
  const serverModule = await serverModulePromise;
  await serverModule.serverReady;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${localPort}/api/state`, { headers: { 'x-kua-yipu-gate': localGate } });
      const home = await fetch(`http://127.0.0.1:${localPort}/`);
      if (response.ok && home.ok && (await home.text()).includes('<!doctype html>')) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('本地工作台服务启动失败');
}

ipcMain.handle('credentials:load', () => loadCredentials());
ipcMain.handle('credentials:clear', () => { clearCredentials(); return true; });
ipcMain.handle('auth:login', async (_event, payload) => {
  const username = String(payload?.username || '').trim();
  const password = String(payload?.password || '');
  if (!username || !password) throw new Error('请输入 Alibaba 国际站账号和密码');
  const deviceId = crypto.createHash('sha256').update(`${app.getPath('userData')}|${username}`).digest('hex');
  const authorization = await authRequest('/api/client/login', { username, deviceId, appVersion: app.getVersion(), deviceName: `${process.platform}-${process.arch}` });
  if (!authorization.authorized || !authorization.token) throw new Error('登录失败');
  currentSession = { ...authorization, username, deviceId, checkedAt: Date.now() };
  try {
    await startAlibabaLogin(username, password);
    if (payload.remember) saveCredentials({ username, password }); else clearCredentials();
    return { username, expiresAt: authorization.expiresAt, token: authorization.token };
  } catch (error) {
    currentSession = null;
    throw error;
  }
});
ipcMain.handle('auth:session', () => currentSession ? { username: currentSession.username, expiresAt: currentSession.expiresAt } : null);
ipcMain.handle('auth:heartbeat', async () => {
  if (!currentSession) return { authorized: false, reason: '尚未登录' };
  try {
    const result = await authRequest('/api/client/heartbeat', {}, currentSession.token);
    if (!result.authorized) { currentSession = null; mainWindow?.close(); }
    else currentSession = { ...currentSession, token: result.token || currentSession.token, expiresAt: result.expiresAt || currentSession.expiresAt, checkedAt: Date.now() };
    return result;
  } catch (error) {
    currentSession = null; mainWindow?.close();
    throw error;
  }
});

async function startAlibabaLogin(username, password) {
  const login = new BrowserWindow({ width: 1280, height: 900, title: 'Alibaba.com 登录', webPreferences: { contextIsolation: true, nodeIntegration: false, partition: `persist:kua-yipu-${username}` } });
  registerAlibabaWindow(login);
  alibabaWindow = login;
  let settled = false;
  let loginSucceeded = false;
  let submitAttempted = false;
  let timer;
  let timeout;
  const setLoginField = (selectors, value) => login.webContents.executeJavaScript(`(() => {
    const selectors = ${JSON.stringify(selectors)};
    const node = selectors.map((selector) => document.querySelector(selector)).find(Boolean);
    if (!node) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(node, ${JSON.stringify(value)});
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`, true).catch(() => false);

  const fillLogin = async () => {
    if (!isWindowAlive(login)) return Promise.resolve(false);
    // Fill one field at a time. Alibaba's risk control treats an immediate
    // bulk injection on first paint as automated login activity.
    const account = await setLoginField(['input[name="account"]','input[name="loginId"]','input[type="text"]','input[type="email"]'], username);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const secret = await setLoginField(['input[name="password"]','input[type="password"]'], password);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return account && secret;
  };

  const pageLooksRendered = async () => login.webContents.executeJavaScript(`(() => {
    const body = document.body;
    const text = String(body?.innerText || '').replace(/\\s+/g, ' ').trim();
    const childCount = body?.children?.length || 0;
    // Alibaba occasionally responds with a JavaScript bundle as a text page
    // during a redirect. It has the right title/URL but is not a usable page.
    const rawScript = /(?:function\\s*\\(|var\\s+[A-Za-z_$]|\\.grecaptcha-badge\\s*\\{)/.test(text.slice(0, 1200))
      && childCount < 3;
    return Boolean(body && !rawScript && childCount >= 3 && text.length > 20);
  })()`, true).catch(() => false);

  return new Promise(async (resolve, reject) => {
    const cleanup = () => {
      if (timer) clearInterval(timer);
      if (timeout) clearTimeout(timeout);
      if (isWindowAlive(login)) login.webContents.removeListener('did-finish-load', onFinishLoad);
      login.removeListener('closed', onClosed);
    };
    const closeQuietly = () => { if (isWindowAlive(login)) login.close(); };
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) { closeQuietly(); reject(error); } else resolve(value);
    };
    const isEnterUrl = (value) => {
      try {
        const parsed = new URL(String(value || ''));
        return parsed.protocol.toLowerCase() === 'kua-yipu:' && parsed.hostname.toLowerCase() === 'enter';
      } catch {
        return /^kua-yipu:\/\/enter(?:[/?#]|$)/i.test(String(value || ''));
      }
    };
    const showEntryError = (error) => {
      const message = String(error?.message || '进入工作台失败，请重试');
      login.webContents.executeJavaScript(`(() => {
        const bar = document.getElementById('__kua_yipu_entry_bar');
        if (!bar) return false;
        const status = bar.querySelector('[data-kua-yipu-status]');
        const button = bar.querySelector('#__kua_yipu_enter');
        if (status) { status.textContent = ${JSON.stringify(message)}; status.style.color = '#b13a31'; }
        if (button) { button.disabled = false; button.textContent = '已登录，点击进入软件'; button.style.background = '#1677ff'; }
        return true;
      })()`, true).catch(() => {});
    };
    const requestEnter = async () => {
      if (!loginSucceeded) {
        const currentUrl = login.webContents.getURL();
        if (/login|passport/i.test(currentUrl)) return;
        loginSucceeded = true;
        await saveAlibabaCookies(login);
        settle(null, { url: currentUrl });
      }
      if (currentSession) {
        try {
          await enterSystemOnce();
        } catch (error) {
          showEntryError(error);
        }
      } else {
        showEntryError(new Error('桌面登录会话尚未建立，请刷新页面后重试'));
      }
    };
    const injectEntryBar = async () => {
      if (!isWindowAlive(login)) return;
      await login.webContents.executeJavaScript(`(() => {
        if (document.getElementById('__kua_yipu_entry_bar')) return true;
        const bar = document.createElement('div');
        bar.id = '__kua_yipu_entry_bar';
        bar.innerHTML = '<span data-kua-yipu-status>Alibaba 登录成功</span><button id="__kua_yipu_enter">已登录，点击进入软件</button><button id="__kua_yipu_refresh">刷新页面</button>';
        Object.assign(bar.style, { position: 'fixed', left: '0', right: '0', bottom: '0', height: '64px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '12px', padding: '0 24px', boxSizing: 'border-box', background: '#fff', borderTop: '1px solid #d9e0e5', boxShadow: '0 -2px 10px rgba(0,0,0,.12)', zIndex: '2147483647', fontFamily: 'Microsoft YaHei, sans-serif', fontSize: '15px', color: '#303840' });
        const enter = bar.querySelector('#__kua_yipu_enter');
        Object.assign(enter.style, { height: '40px', padding: '0 22px', border: '0', borderRadius: '4px', background: '#1677ff', color: '#fff', cursor: 'pointer', fontSize: '15px' });
        const refresh = bar.querySelector('#__kua_yipu_refresh');
        Object.assign(refresh.style, { height: '40px', padding: '0 22px', border: '1px solid #b9c2cc', borderRadius: '4px', background: '#fff', color: '#303840', cursor: 'pointer', fontSize: '15px' });
        enter.addEventListener('click', (event) => {
          event.preventDefault();
          enter.disabled = true;
          enter.textContent = '正在进入…';
          enter.style.background = '#7aaef7';
          try { window.open('kua-yipu://enter', '_blank'); } catch {}
          // Some Chromium builds do not dispatch window.open for custom schemes.
          // The navigation fallback reaches Electron's will-navigate handler.
          setTimeout(() => { try { window.location.href = 'kua-yipu://enter/'; } catch {} }, 120);
        });
        refresh.addEventListener('click', () => location.reload());
        document.body.appendChild(bar);
        document.body.style.paddingBottom = '72px';
        return true;
      })()`, true).catch(() => false);
    };
    const onClosed = () => {
      if (alibabaWindow === login) alibabaWindow = null;
      if (!loginSucceeded) settle(new Error('登录失败'));
    };
    const onFinishLoad = async () => {
      if (settled || !isWindowAlive(login)) return;
      const currentUrl = login.webContents.getURL();
      const isLoginPage = /login|passport/i.test(currentUrl);
      if (!isLoginPage && !await pageLooksRendered()) {
        // Alibaba often paints the shell in several asynchronous steps. Do
        // not reload the page while it is settling: repeated reloads trigger
        // risk control and were the reason users saw three refreshes before
        // the entry bar appeared. The 500 ms inspector below will continue
        // checking until the existing document becomes usable.
        return;
      }
      // Do not show the success bar on the login form itself. It is only
      // meaningful after Alibaba has left the login route.
      if (isLoginPage) {
        if (submitAttempted) return;
        submitAttempted = true;
        await fillLogin();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!settled && isWindowAlive(login)) {
          await login.webContents.executeJavaScript(`document.querySelector('button[type="submit"],button[class*="submit"],input[type="submit"]')?.click()`).catch(() => {});
        }
        return;
      }
      await injectEntryBar();
    };
    login.once('closed', onClosed);
    login.webContents.setWindowOpenHandler(({ url }) => {
      if (isEnterUrl(url)) {
        requestEnter().catch(showEntryError);
        return { action: 'deny' };
      }
      try {
        return { action: /^https?:$/i.test(new URL(url).protocol) ? 'allow' : 'deny' };
      } catch {
        return { action: 'deny' };
      }
    });
    login.webContents.on('will-navigate', (event, url) => {
      if (isEnterUrl(url)) {
        event.preventDefault();
        requestEnter().catch(showEntryError);
      }
    });
    login.webContents.on('did-finish-load', onFinishLoad);
    try {
      await login.loadURL('https://login.alibaba.com/');
    } catch (error) {
      settle(new Error('登录失败'));
      return;
    }
    const inspect = async () => {
      if (settled || !isWindowAlive(login)) return;
      const url = login.webContents.getURL();
      const bodyText = await login.webContents.executeJavaScript('document.body?.innerText || ""').catch(() => '');
      if (/captcha|滑块|请完成验证|人机验证|安全验证|向右滑动验证|verify you are human/i.test(bodyText)) {
        if (isWindowAlive(login)) {
          login.show();
          login.maximize();
          login.focus();
        }
        return;
      }
      if (/account name or password is incorrect|incorrect password|账号或密码错误|密码错误/i.test(bodyText)) {
        settle(new Error('登录失败'));
        return;
      }
      const hasLoginForm = await login.webContents.executeJavaScript(`Boolean(document.querySelector('input[type="password"], input[name="password"], input[name="loginId"], input[name="account"]'))`).catch(() => true);
      if (!hasLoginForm && !/login|passport/i.test(url) && await pageLooksRendered()) {
        loginSucceeded = true;
        await injectEntryBar();
        await saveAlibabaCookies(login);
        settle(null, { url });
      }
    };
    timer = setInterval(() => { inspect().catch(() => settle(new Error('登录失败'))); }, 500);
    timeout = setTimeout(() => settle(new Error('登录失败')), 600000);
  });
}

app.whenReady().then(() => {
  hasSingleInstanceLock = app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) { app.quit(); return; }
  app.on('second-instance', () => {
    for (const window of [loginWindow, mainWindow, ...liveAlibabaWindows()]) {
      if (isWindowAlive(window)) {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        break;
      }
    }
  });
  // Show the login window immediately. Native modules and the local API warm
  // up in parallel so startup is responsive on first launch and after install.
  createLoginWindow();
  ensureLocalServer().catch((error) => {
    if (isWindowAlive(loginWindow)) {
      dialog.showErrorBox('跨易铺启动失败', `本地工作台服务启动失败：${error.message}`);
    }
  });
});

// The local server runs in this same Electron process. Exposing this narrow
// bridge lets the seller page reuse the authenticated Electron session instead
// of opening a second Playwright profile that would ask the user to log in
// again.
globalThis.__KUA_YIPU_SELLER_BRIDGE = {
  open: showAlibabaSellerWindow,
  bind: inspectAndHideAlibabaSellerWindow,
  status: () => {
    const seller = currentAlibabaWindow({ preferPosting: true });
    return {
      browserOpen: isWindowAlive(seller),
      visible: isWindowAlive(seller) && seller.isVisible(),
      currentUrl: isWindowAlive(seller) ? seller.webContents.getURL() : '',
      onAlibabaInternational: isWindowAlive(seller) && /^https?:\/\/(?:[^/]+\.)?alibaba\.com/i.test(seller.webContents.getURL())
    };
  }
};

ipcMain.handle('auth:enter', async () => enterSystem());
app.on('before-quit', () => {
  currentSession = null;
  if (isWindowAlive(loginWindow)) loginWindow.destroy();
  if (isWindowAlive(mainWindow)) mainWindow.destroy();
  for (const window of liveAlibabaWindows()) window.destroy();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
