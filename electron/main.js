import { app, BrowserWindow, dialog, ipcMain, safeStorage, session } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AuthorizationLease, isRetryableAuthorizationError } from './auth-lease.js';
import { matchesAlibabaSession, checkAlibabaLoginAccount } from './alibaba-identity.js';
import { loginWithAlibaba, rememberedLoginCredentials } from './alibaba-login.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';
import { authorizationEndpoint } from '../server/auth-endpoint.js';
import { showHumanVerification } from './human-verification.js';
import { saveAccountCookies } from './seller-session.js';
import { browserStep } from '../server/browser-step.js';
import { captureSellerReferenceWithExecutor } from '../server/seller-reference.js';
import { startLocalService } from './local-service.js';
import { navigateSourceWindow, sourceProductUrl } from './source-navigation.js';
import { Updater } from './updater.js';
import { launchInstaller } from './update-install.js';
import { UPDATE_CONFIG } from './update-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const appIcon = path.join(rootDir, app.isPackaged ? 'dist' : 'public', 'brand.png');
app.on('browser-window-created', (_event, window) => {
  window.setIcon(appIcon);
  window.setMenuBarVisibility(false);
});
app.on('web-contents-created', (_event, contents) => {
  if (app.isPackaged) contents.on('devtools-opened', () => contents.closeDevTools());
  contents.on('will-attach-webview', (event) => event.preventDefault());
});
const localPort = Number(process.env.KUA_YIPU_PORT || 8787);
const authBaseUrl = authorizationEndpoint(app.isPackaged ? undefined : process.env.KUA_YIPU_AUTH_URL, { development: !app.isPackaged });
process.env.KUA_YIPU_AUTH_URL = authBaseUrl;
let serverModulePromise;
let localService;
let localServerPromise;
let loginWindow;
let mainWindow;
let alibabaWindow;
const alibabaWindows = new Set();
const registeredAlibabaWindows = new WeakSet();
let currentSession = null;
let readableAccount = '';
let enterSystemPromise = null;
let shutdownStarted = false;
let shutdownComplete = false;
let skipQuitPrompt = false;
let quitPromptOpen = false;
const localGate = crypto.randomBytes(32).toString('hex');
const authorizationLease = new AuthorizationLease();
let heartbeatPromise;
let authorizationConnection = { state: 'connected', message: '' };
let authorizationWorkPaused = false;
let nextHeartbeat = 0;
let hasSingleInstanceLock = false;
let updater;
let updaterError = '';
let installingUpdate = false;
let loginAttemptInProgress = false;

function alibabaCookiesFile() {
  return path.join(app.getPath('userData'), 'alibaba-cookies.json');
}

async function saveAlibabaCookies(login) {
  try {
    const cookies = await browserStep(() => login.webContents.session.cookies.get({}), { timeoutMs: 5000, label: '读取卖家登录状态' });
    writePrivateSession(alibabaCookiesFile(), cookies);
  } catch {
    // Cookie synchronization is best-effort; Alibaba may still expose public
    // listing data when the session cannot be exported.
  }
}

async function saveAlibabaSession(login) {
  await saveAlibabaCookies(login);
  try {
    const url = login.webContents.getURL();
    const origin = new URL(url).origin;
    if (!/(^|\.)alibaba\.com$/i.test(new URL(url).hostname)) return;
    const storage = await browserStep(() => login.readStorage ? login.readStorage()
      : login.webContents.executeJavaScript('Object.fromEntries(Object.entries(localStorage))', true),
    { timeoutMs: 3000, label: '读取卖家页面存储' });
    const file = path.join(path.dirname(alibabaCookiesFile()), 'alibaba-storage.json');
    let all = {};
    try { all = readPrivateSession(file); } catch {}
    all[origin] = storage && typeof storage === 'object' ? storage : {};
    writePrivateSession(file, all);
  } catch {
    // Some Alibaba pages disable script access during a redirect; cookies are
    // still persisted by saveAlibabaCookies above.
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

function activationCredentials(username, activationCode) {
  const file = path.join(app.getPath('userData'), 'activation-credentials.bin');
  let values = {};
  try { values = JSON.parse(safeStorage.decryptString(fs.readFileSync(file))); } catch {}
  const key = crypto.createHash('sha256').update(username).digest('hex');
  if (activationCode) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('当前 Windows 环境不支持安全凭据存储');
    values[key] = activationCode;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(values)));
    fs.renameSync(temporary, file);
  }
  return values[key] || '';
}

async function authRequest(endpoint, body, token = '') {
  if (!authBaseUrl) throw new Error('登录失败');
  let response;
  try {
    response = await fetch(`${authBaseUrl}${endpoint}`, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000)
    });
  } catch {
    throw Object.assign(new Error('暂时无法连接授权服务器，请检查网络后重试'), { retryable: true });
  }
  let data;
  try { data = await response.json(); }
  catch {
    if (response.ok) throw Object.assign(new Error('授权服务响应中断，正在等待重试'), { retryable: true });
    data = {};
  }
  data.serverTime ||= response.headers.get('date');
  if (!response.ok) throw Object.assign(new Error(data.reason || data.error || '授权验证失败'), { status: response.status });
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
  // Track every real browser window created by Alibaba. Some pages use
  // window.open(), while others navigate a named target; accepting only the
  // default Electron behavior leaves the child outside our registry and the
  // bind action keeps inspecting the old parent window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      return { action: /^https?:$/i.test(new URL(url).protocol) ? 'allow' : 'deny' };
    } catch {
      return { action: 'deny' };
    }
  });
  window.webContents.on('did-create-window', (child) => {
    registerAlibabaWindow(child);
    alibabaWindow = child;
  });
  const selectIfPosting = (_event, url) => {
    if (isAlibabaProductPostingUrl(url) && isWindowAlive(window)) alibabaWindow = window;
  };
  window.webContents.on('did-navigate', selectIfPosting);
  window.webContents.on('did-frame-navigate', selectIfPosting);
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
  loginWindow = new BrowserWindow({ width: 520, height: 720, resizable: false, show: false, title: '抄得快登录', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false } });
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
      dialog.showErrorBox('抄得快启动失败', `登录界面加载失败：${error.message}`);
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
  const html = `<!doctype html><meta charset="utf-8"><title>抄得快启动失败</title><style>body{font-family:Microsoft YaHei,sans-serif;margin:0;background:#f4f6f7;color:#182028;display:grid;place-items:center;height:100vh}.box{background:#fff;border:1px solid #dfe4e7;border-radius:8px;padding:32px 38px;box-shadow:0 8px 26px #18202822;max-width:620px}h1{font-size:22px;margin:0 0 12px;color:#f06423}p{line-height:1.7;color:#59666c;word-break:break-word}button{height:40px;padding:0 22px;border:0;border-radius:5px;background:#f06423;color:#fff;font-weight:700;cursor:pointer}</style><main class="box"><h1>工作台暂时未能打开</h1><p>${message}</p><button onclick="location.href=${JSON.stringify(retryUrl)}">重新加载</button></main>`;
  window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
}

function workbenchLoadingUrl() {
  const html = '<!doctype html><meta charset="utf-8"><title>抄得快</title><style>body{font-family:Microsoft YaHei,sans-serif;margin:0;background:#f4f6f7;color:#59666c;display:grid;place-items:center;height:100vh}.box{text-align:center}.spinner{width:28px;height:28px;border:3px solid #dfe4e7;border-top-color:#f06423;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 16px}@keyframes spin{to{transform:rotate(360deg)}}</style><main class="box"><div class="spinner"></div><div>正在启动工作台，请稍候…</div></main>';
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({ width: 1440, height: 960, minWidth: 1100, minHeight: 720, title: '抄得快', autoHideMenuBar: true, show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false } });
  const window = mainWindow;
  window.webContents.session.webRequest.onBeforeSendHeaders({ urls: [`http://127.0.0.1:${localPort}/api/*`] }, (details, callback) => {
    if (details.webContentsId === window.webContents.id) details.requestHeaders['X-Kua-Yipu-Gate'] = localGate;
    callback({ requestHeaders: details.requestHeaders });
  });
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) console.error(`工作台渲染错误 ${sourceId}:${line} ${message}`);
  });
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
  // The Alibaba and automation windows may be hidden rather than closed.
  // Closing the visible workbench must therefore quit the whole application,
  // otherwise those windows keep Electron alive and block the next installer.
  window.on('close', (event) => {
    if (shutdownStarted || skipQuitPrompt) return;
    event.preventDefault();
    if (quitPromptOpen) return;
    quitPromptOpen = true;
    dialog.showMessageBox(window, {
      type: 'question',
      title: '确认退出',
      message: '确认退出抄得快吗？',
      detail: '退出后正在运行的采集或上架任务会停止。已保存的数据会保留。',
      buttons: ['确认退出', '取消退出'],
      defaultId: 1,
      cancelId: 1,
      checkboxLabel: '本次登录不再提示',
      checkboxChecked: false
    }).then(({ response, checkboxChecked }) => {
      quitPromptOpen = false;
      if (response !== 0) return;
      if (checkboxChecked) skipQuitPrompt = true;
      app.quit();
    }).catch(() => { quitPromptOpen = false; });
  });
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

async function ensureAlibabaSellerWindow({ navigate = true } = {}) {
  const existing = currentAlibabaWindow({ preferPosting: true });
  if (isWindowAlive(existing)) return existing;
  const username = currentSession?.username;
  if (!username) throw new Error('登录失败');
  const seller = new BrowserWindow({
    width: 1440,
    height: 960,
    show: false,
    skipTaskbar: true,
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
  if (navigate) await Promise.race([
    seller.loadURL('https://i.alibaba.com/'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('My Alibaba 页面加载超时，请在已打开的浏览器中检查登录或验证码')), 45000))
  ]);
  return seller;
}

async function showAlibabaSellerWindow() {
  // Reuse the authenticated Alibaba session, including any tracked child
  // window, before creating another browser profile.
  const seller = await ensureAlibabaSellerWindow();
  seller.setSkipTaskbar(false);
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

async function openAlibabaSourceWindow(sourceUrl) {
  const url = sourceProductUrl(sourceUrl);
  const seller = await ensureAlibabaSellerWindow({ navigate: false });
  return navigateSourceWindow(seller, url);
}

async function handleAlibabaHumanVerification(url, options = {}) {
  const username = currentSession?.username;
  if (!username || !String(url || '')) return false;
  return showHumanVerification({
    url, partition: `persist:kua-yipu-${username}`, icon: appIcon,
    shouldStop: () => shutdownStarted || !currentSession?.verified || options.shouldStop?.(),
    onWaiting: options.onWaiting,
    userAgent: options.userAgent,
    requestCookies: options.requestCookies,
    saveSession: saveAlibabaSession
  });
}

async function inspectAndHideAlibabaSellerWindow() {
  const windows = liveAlibabaWindows();
  if (!windows.length) return null;
  let postingPage = null;
  try {
    // A child posting form can still be loading when the user clicks Bind.
    // Poll the current registry briefly so we inspect the real form instead of
    // racing the parent Products page.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !postingPage?.details?.hasTitleField) {
      for (const seller of [...liveAlibabaWindows()].reverse()) {
        const details = await seller.webContents.executeJavaScript(`(() => {
          const visible = (node) => Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
          const titleField = [...document.querySelectorAll('input, textarea, [contenteditable="true"]')].find((node) => {
            if (!visible(node)) return false;
            const text = [node.name, node.id, node.placeholder, node.getAttribute('aria-label'), node.getAttribute('data-testid')].join(' ');
            return /product\\s*(title|name)|商品标题|产品名称|标题/i.test(text);
          });
          const body = document.body?.innerText || '';
          const category = body.match(/当前类目：\\s*([^\\n]+)/)?.[1]?.trim()
            || body.match(/(?:Current category|Category)\\s*:\\s*([^\\n]+)/i)?.[1]?.trim() || '';
          return { url: location.href, title: document.title || '', category, hasTitleField: Boolean(titleField) };
        })()`, true).catch(() => null);
        if (!details || !isAlibabaProductPostingUrl(details.url)) continue;
        postingPage ||= { seller, details };
        if (details.hasTitleField) { postingPage = { seller, details }; break; }
      }
      if (postingPage?.details?.hasTitleField) break;
      await wait(350);
    }
    if (!postingPage) throw new Error('当前不是国际站商品发布页，请进入 Products → Post Products 并打开商品填写表单');
    if (!postingPage.details.hasTitleField) throw new Error('请先完成类目选择并打开商品填写表单后再绑定');
    alibabaWindow = postingPage.seller;
    await saveAlibabaCookies(postingPage.seller);
    return { url: postingPage.details.url, title: postingPage.details.title, category: postingPage.details.category };
  } finally {
    for (const window of liveAlibabaWindows()) { window.setSkipTaskbar(true); window.hide(); }
  }
}

async function enterSystem() {
  if (!currentSession?.verified || !authorizationLease.valid()) throw new Error('请连接网络并重新验证授权');
  const account = currentSession.username;
  const cookies = await session.fromPartition(`persist:kua-yipu-${account}`).cookies.get({ domain: 'alibaba.com' });
  if (!currentSession?.verified || currentSession.username !== account
    || !matchesAlibabaSession(cookies, account, 'https://www.alibaba.com/')) {
    revokeLocalSession();
    throw new Error('Alibaba 实际登录账号与软件授权不一致或已退出，请重新登录');
  }
  // Switch windows immediately. Server startup, cookie export, and renderer
  // loading are supervised in the background so the Alibaba page can never be
  // held in an endless "正在进入" state.
  const seller = currentAlibabaWindow();
  if (isWindowAlive(seller)) saveAlibabaSession(seller).catch(() => {});
  if (isWindowAlive(mainWindow)) {
    mainWindow.show();
    mainWindow.focus();
    const startupTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('本地工作台服务启动超时，请重试')), 15000));
    Promise.race([ensureLocalServer(), startupTimeout]).then(() => {
      if (mainWindow.webContents.getURL() !== mainWindowUrl()) return loadWorkbench(mainWindow);
    }).catch((error) => showWorkbenchError(mainWindow, error));
  } else {
    createMainWindow().catch((error) => showWorkbenchError(mainWindow, error));
  }
  for (const window of liveAlibabaWindows()) { window.setSkipTaskbar(true); window.hide(); }
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
  const entry = path.join(rootDir, 'server', 'index.js');
  const dataDir = path.join(app.getPath('userData'), '.data');
  process.env.PORT = String(localPort);
  process.env.DATA_DIR = dataDir;
  process.env.KUA_YIPU_DESKTOP = '1';
  process.env.KUA_YIPU_ACCOUNT = currentSession?.username || 'local';
  process.env.KUA_YIPU_LOCAL_GATE = localGate;
  // A packaged client must use the Chromium shipped in resources/chromium.
  // Development builds may still use the local Playwright cache.
  // Electron always uses the repository/package Chromium. Standalone web
  // server users may still opt into their own browser outside this process.
  process.env.KUA_YIPU_REQUIRE_BUNDLED_BROWSER = '1';
  process.env.APP_ROOT_DIR = app.isPackaged ? app.getAppPath() : rootDir;
  process.env.KUA_YIPU_DIST_DIR = path.join(process.env.APP_ROOT_DIR, 'dist');
  process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = alibabaCookiesFile();
  if (!serverModulePromise) {
    localService = startLocalService({ entry, env: { ...process.env }, resourcesPath: process.resourcesPath,
      handlers: {
        ...Object.fromEntries(Object.entries(globalThis.__KUA_YIPU_SELLER_BRIDGE).map(([name, handler]) => [`seller.${name}`, handler])),
        authorization: () => ({ valid: globalThis.__KUA_YIPU_AUTHORIZATION.valid(), canRead: globalThis.__KUA_YIPU_AUTHORIZATION.canRead(), account: currentSession?.username || readableAccount || 'local' }),
        'secure.encrypt': (value) => globalThis.__KUA_YIPU_SECURE_STORAGE.encrypt(value),
        'secure.decrypt': (value) => globalThis.__KUA_YIPU_SECURE_STORAGE.decrypt(Buffer.from(value)),
      } });
    serverModulePromise = localService.ready.then(() => ({
      suspendAuthorizedWork: (options) => localService.call('suspendAuthorizedWork', options),
      shutdownServer: () => localService.call('shutdownServer'),
      prepareForUpdate: () => localService.call('prepareForUpdate'),
      cancelUpdatePreparation: () => localService.call('cancelUpdatePreparation'),
    }));
  }
  const serverModule = await serverModulePromise;
  await serverModule.serverReady;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${localPort}/health`);
      const home = await fetch(`http://127.0.0.1:${localPort}/`);
      if (response.ok && home.ok && (await home.text()).includes('<!doctype html>')) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('本地工作台服务启动失败');
}

function handleLocalIpc(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    const trustedWindow = [loginWindow, mainWindow].find((window) => isWindowAlive(window) && window.webContents === event.sender);
    const trustedUrl = event.senderFrame?.url;
    if (!trustedWindow || event.senderFrame !== event.sender.mainFrame || ![pathToFileURL(path.join(__dirname, 'login.html')).href, mainWindowUrl()].includes(trustedUrl)) throw new Error('拒绝未授权的页面请求');
    return handler(event, ...args);
  });
}

handleLocalIpc('credentials:load', () => loadCredentials());
function requireUpdater() { if (!updater) throw new Error(updaterError || '更新服务尚未就绪'); return updater; }
handleLocalIpc('update:state', () => ({ ...(updater?.state() || { currentVersion: app.getVersion(), status: 'error', error: updaterError }), canInstall: Boolean(updater) && app.isPackaged && process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_FILE }));
handleLocalIpc('update:check', () => requireUpdater().check());
handleLocalIpc('update:download', () => { const active = requireUpdater(); void active.download().catch((error) => active.set({ status: 'error', error: error.message })); return active.state(); });
handleLocalIpc('update:cancel', () => { const active = requireUpdater(); active.cancel(); return active.state(); });
handleLocalIpc('update:install', async (event) => {
  requireUpdater();
  if (installingUpdate || shutdownStarted) throw new Error('正在准备安装更新');
  if (!app.isPackaged || process.platform !== 'win32' || process.env.PORTABLE_EXECUTABLE_FILE) throw new Error('请使用 Windows 安装版进行在线更新');
  installingUpdate = true;
  let service;
  try {
    await updater.prepare();
    const answer = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
      type: 'question', title: '安装抄得快更新', buttons: ['退出并安装', '暂不安装'], defaultId: 1, cancelId: 1,
      message: `安装 ${updater.state().release.version}？`,
      detail: '软件将退出，安装完成后自动打开。商品、图片、模板、授权和任务记录保留；未完成的任务需要您确认后继续。',
    });
    if (answer.response !== 0) return updater.state();
    await ensureLocalServer();
    service = await serverModulePromise;
    await service.prepareForUpdate();
    const file = await updater.prepare();
    updater.set({ status: 'installing', error: '' });
    await launchInstaller({ file, directory: updater.directory, target: path.dirname(app.getPath('exe')) });
    skipQuitPrompt = true;
    app.quit();
    return updater.state();
  } catch (error) {
    await service?.cancelUpdatePreparation().catch(() => {});
    updater.set({ status: updater.state().release ? 'ready' : 'error', error: error.message });
    throw error;
  } finally { installingUpdate = false; }
});
handleLocalIpc('credentials:clear', () => { clearCredentials(); return true; });
handleLocalIpc('activation:status', (_event, username) => Boolean(activationCredentials(String(username || '').trim())));
handleLocalIpc('auth:login', async (_event, payload) => {
  if (loginAttemptInProgress) throw new Error('正在验证登录，请完成当前登录或关闭阿里登录窗口后重试');
  loginAttemptInProgress = true;
  try {
    const username = String(payload?.username || '').trim();
    const password = String(payload?.password || '');
    if (!username || !password) throw new Error('请输入 Alibaba 国际站账号和密码');
    const suppliedCode = String(payload?.activationCode || '').trim();
    if (suppliedCode && !/^CDK-[A-Za-z0-9_-]{43}$/.test(suppliedCode)) throw new Error('软件授权码格式不正确，请填写管理员提供的完整授权码');
    const activationCode = suppliedCode || activationCredentials(username);
    const deviceFile = path.join(app.getPath('userData'), 'device-id');
    let installationId = fs.existsSync(deviceFile) ? fs.readFileSync(deviceFile, 'utf8').trim() : '';
    if (!/^[a-f0-9-]{36}$/i.test(installationId)) { installationId = crypto.randomUUID(); fs.writeFileSync(deviceFile, installationId); }
    const deviceId = crypto.createHash('sha256').update(`${installationId}|${os.hostname()}|${username}`).digest('hex');
    const authorization = await authRequest('/api/client/login', { username, deviceId, activationCode, connectionPolicyVersion: 2, appVersion: app.getVersion(), deviceName: `${os.hostname()} (${process.platform}-${process.arch})` });
    if (!authorization.authorized || !authorization.token) throw new Error('登录失败');
    if (suppliedCode) activationCredentials(username, suppliedCode);
    currentSession = { ...authorization, username, deviceId, checkedAt: Date.now() };
    authorizationConnection = { state: 'connected', message: '' };
    authorizationWorkPaused = false;
    try {
      const result = await startAlibabaLogin(username, password);
      process.env.KUA_YIPU_ACCOUNT = username;
      if (payload.remember) saveCredentials(rememberedLoginCredentials(username, password, result)); else clearCredentials();
      return { username, expiresAt: currentSession?.expiresAt };
    } catch (error) {
      currentSession = null;
      authorizationLease.clear();
      throw error;
    }
  } finally { loginAttemptInProgress = false; }
});
handleLocalIpc('auth:session', () => currentSession?.verified && authorizationLease.valid() ? { username: currentSession.username, expiresAt: currentSession.expiresAt } : null);

function revokeLocalSession() {
  if (currentSession?.verified) readableAccount = currentSession.username;
  authorizationLease.clear();
  currentSession = null;
  authorizationConnection = { state: 'revoked', message: '软件授权已失效，任务和工作台已保留，请重新登录' };
  serverModulePromise?.then((module) => module.suspendAuthorizedWork?.({ graceful: true })).catch(() => {});
  if (isWindowAlive(mainWindow)) {
    if (!isWindowAlive(loginWindow)) createLoginWindow();
  }
}

function pauseDisconnectedWork() {
  authorizationConnection = { state: 'paused', message: '授权连接中断，已暂停后续任务，正在自动重连' };
  if (authorizationWorkPaused) return;
  authorizationWorkPaused = true;
  serverModulePromise?.then((module) => module.suspendAuthorizedWork?.({ graceful: true })).catch(() => {});
}

handleLocalIpc('auth:connection', () => ({ ...authorizationConnection, remainingSeconds: authorizationLease.remainingSeconds() }));
handleLocalIpc('auth:show-login', () => { if (!isWindowAlive(loginWindow)) createLoginWindow(); else loginWindow.show(); });

async function checkAuthorization() {
  if (heartbeatPromise) return heartbeatPromise;
  heartbeatPromise = refreshAuthorization().finally(() => { heartbeatPromise = null; });
  return heartbeatPromise;
}

async function refreshAuthorization() {
  if (!currentSession) return { authorized: false, reason: '尚未登录' };
  const checkedSession = currentSession;
  const started = performance.now();
  try {
    let result;
    try { result = await authRequest('/api/client/heartbeat', {}, checkedSession.token); }
    catch (error) {
      const activationCode = activationCredentials(checkedSession.username);
      if (error.status !== 401 || !checkedSession.verified || !activationCode || currentSession !== checkedSession) throw error;
      result = await authRequest('/api/client/login', { username: checkedSession.username, deviceId: checkedSession.deviceId,
        activationCode, connectionPolicyVersion: 2, appVersion: app.getVersion(), deviceName: `${os.hostname()} (${process.platform}-${process.arch})` });
    }
    if (currentSession !== checkedSession) return { authorized: Boolean(currentSession) };
    authorizationLease.renew(result, started);
    currentSession = { ...currentSession, token: result.token || currentSession.token, expiresAt: result.expiresAt };
    authorizationConnection = { state: 'connected', message: authorizationWorkPaused ? '授权连接已恢复，暂停的任务可继续' : '' };
    authorizationWorkPaused = false;
    nextHeartbeat = performance.now() + 30000;
    return { authorized: true, expiresAt: result.expiresAt };
  } catch (error) {
    if (currentSession !== checkedSession) return { authorized: Boolean(currentSession) };
    if (checkedSession.verified && isRetryableAuthorizationError(error) && !authorizationLease.expired()) {
      nextHeartbeat = performance.now() + 5000;
      if (authorizationLease.valid()) authorizationConnection = { state: 'retrying', message: '授权连接暂时中断，正在重试，任务继续运行' };
      else pauseDisconnectedWork();
      return { authorized: authorizationLease.valid(), reconnecting: true };
    }
    revokeLocalSession();
    throw error;
  }
}
handleLocalIpc('auth:heartbeat', () => checkAuthorization());

async function startAlibabaLogin(username, password) {
  const login = new BrowserWindow({ width: 1280, height: 900, title: 'Alibaba.com 登录', webPreferences: { contextIsolation: true, nodeIntegration: false, partition: `persist:kua-yipu-${username}` } });
  registerAlibabaWindow(login);
  alibabaWindow = login;
  const authorizedSession = currentSession;
  login.once('closed', () => { if (alibabaWindow === login) alibabaWindow = null; });
  return loginWithAlibaba(login, {
    username, password,
    matchesSession: async () => checkAlibabaLoginAccount(await login.webContents.session.cookies.get({ domain: 'alibaba.com' }), username, login.webContents.getURL()),
    checkAuthorization: async () => {
      await checkAuthorization();
      if (!currentSession || currentSession.username !== authorizedSession.username) throw new Error('软件授权校验失败，请重新登录');
    },
    onVerified: () => {
      if (!currentSession || currentSession.username !== username) throw new Error('软件授权已失效，请重新登录');
      currentSession.verified = true;
    },
    saveSession: () => saveAlibabaSession(login),
    enterSystem: async () => {
      if (!currentSession?.verified || currentSession.username !== username) throw new Error('请使用与软件授权一致的账号重新登录');
      await enterSystemOnce();
    },
    onStatus: (message) => { if (isWindowAlive(loginWindow)) loginWindow.webContents.send('auth:login-status', message); },
    onCredentialsRejected: () => {
      const saved = loadCredentials();
      if (saved?.username === username) clearCredentials();
    },
  });
}

app.whenReady().then(() => {
  hasSingleInstanceLock = app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) { app.quit(); return; }
  try {
    updater = new Updater({ directory: path.join(app.getPath('userData'), 'updates'), version: app.getVersion(), config: UPDATE_CONFIG });
    updater.start();
  } catch (error) { updaterError = `更新目录暂时不可用，请检查磁盘空间和权限：${error.message}`; }
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
  setInterval(() => {
    if (!currentSession?.verified) return;
    if (authorizationLease.expired()) { revokeLocalSession(); return; }
    if (!authorizationLease.valid()) pauseDisconnectedWork();
    if (performance.now() >= nextHeartbeat) checkAuthorization().catch(() => {});
  }, 5000).unref();
  ensureLocalServer().catch((error) => {
    if (isWindowAlive(loginWindow)) {
      dialog.showErrorBox('抄得快启动失败', `本地工作台服务启动失败：${error.message}`);
    }
  });
});

// The background service uses this narrow bridge to reuse the authenticated
// Electron session. All window and credential APIs stay on the window thread.
globalThis.__KUA_YIPU_SELLER_BRIDGE = {
  open: showAlibabaSellerWindow,
  openSource: openAlibabaSourceWindow,
  humanVerification: handleAlibabaHumanVerification,
  sync: async () => {
    const seller = currentAlibabaWindow({ preferPosting: true });
    if (isWindowAlive(seller)) await saveAlibabaSession(seller);
    else {
      return saveAccountCookies(currentSession?.verified && currentSession.username, session, alibabaCookiesFile());
    }
    return true;
  },
  bind: inspectAndHideAlibabaSellerWindow,
  captureReference: async () => {
    const seller = currentAlibabaWindow({ preferPosting: true });
    if (!isWindowAlive(seller)) throw new Error('请先打开卖家窗口，并进入已有商品的编辑表单');
    return browserStep(() => captureSellerReferenceWithExecutor((script) => seller.webContents.executeJavaScript(script)),
      { label: '读取当前卖家商品模板', timeoutMs: 45000 });
  },
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

globalThis.__KUA_YIPU_AUTHORIZATION = { valid: () => Boolean(currentSession?.verified && authorizationLease.valid()), canRead: () => Boolean(currentSession?.verified || readableAccount) };
globalThis.__KUA_YIPU_SECURE_STORAGE = {
  encrypt: (value) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统无法加密 API 密钥');
    return safeStorage.encryptString(value);
  },
  decrypt: (value) => safeStorage.decryptString(value),
};
handleLocalIpc('auth:enter', async () => enterSystem());
handleLocalIpc('alibaba:open-source', async (_event, url) => {
  if (!currentSession?.verified || !authorizationLease.valid()) throw new Error('请先登录');
  return openAlibabaSourceWindow(url);
});
app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  updater?.close();
  currentSession = null;
  if (isWindowAlive(loginWindow)) loginWindow.destroy();
  if (isWindowAlive(mainWindow)) mainWindow.destroy();
  for (const window of liveAlibabaWindows()) window.destroy();
  const shutdown = async () => {
    try {
      const serverModule = serverModulePromise ? await serverModulePromise : null;
      await serverModule?.shutdownServer?.();
    } catch {}
  };
  // A normal quit lets Chromium persist its encryption key and profile state.
  Promise.race([shutdown(), wait(4000)]).finally(async () => {
    await localService?.terminate();
    shutdownComplete = true; app.quit();
  });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !shutdownStarted) app.quit(); });
