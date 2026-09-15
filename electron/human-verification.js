import { BrowserWindow, WebContentsView, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectVerificationDocument, waitForVerification, verificationPaused } from '../server/human-verification.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sessions = new Map();
const allowedUrl = (value) => {
  try { const url = new URL(value); return url.protocol === 'https:' && /(^|\.)(?:alibaba\.com|1688\.com|aliexpress\.com|alicdn\.com)$/.test(url.hostname); }
  catch { return false; }
};

ipcMain.handle('verification:refresh', (event) => {
  const current = sessions.get(event.sender.id);
  if (!current || event.senderFrame !== event.sender.mainFrame) throw new Error('验证窗口不可用');
  current.refresh();
});
ipcMain.handle('verification:pause', (event) => {
  const current = sessions.get(event.sender.id);
  if (!current || event.senderFrame !== event.sender.mainFrame) throw new Error('验证窗口不可用');
  current.pause();
});

export async function showHumanVerification({ url, partition, icon, shouldStop = () => false,
  onWaiting = () => {}, saveSession = async () => {}, onCreated = () => {}, userAgent = '', requestCookies = [] }) {
  if (!allowedUrl(url)) throw new Error('验证页面地址不受支持');
  const window = new BrowserWindow({ width: 1280, height: 920, minWidth: 640, minHeight: 480,
    show: false, skipTaskbar: true, title: '抄得快 - 人工验证', icon, autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(directory, 'verification-preload.cjs') } });
  const view = new WebContentsView({ webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.contentView.addChildView(view);
  const contents = view.webContents;
  // Verification and the requesting browser must identify the same client;
  // otherwise a healthy Electron page may not restore the collector session.
  if (userAgent) contents.setUserAgent(userAgent);
  const resize = () => { const [width, height] = window.getContentSize(); view.setBounds({ x: 0, y: 64, width, height: Math.max(1, height - 64) }); };
  window.on('resize', resize);
  resize();
  let paused = false;
  let loadFailed = false;
  let navigation = 0;
  let refreshedAt = 0;
  let revealed = false;
  let probeExpired = false;
  let probeTimer;
  let documentCommitted = false;
  const closed = () => window.isDestroyed() || contents.isDestroyed();
  const status = (message) => { if (!window.isDestroyed()) window.webContents.send('verification:status', message); };
  const refresh = () => {
    if (closed() || Date.now() - refreshedAt < 500) return;
    refreshedAt = Date.now();
    loadFailed = false;
    contents.stop();
    status('正在刷新验证页面');
    const current = contents.getURL();
    if (allowedUrl(current)) contents.reload();
    else contents.loadURL(url).catch(() => {});
  };
  const pause = () => { paused = true; };
  const senderId = window.webContents.id;
  sessions.set(senderId, { refresh, pause });
  window.on('close', (event) => {
    event.preventDefault();
    if (!revealed) { paused = true; return; }
    status('等待完成验证；需要停止时可暂停任务'); window.show();
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, target) => { if (!allowedUrl(target)) event.preventDefault(); });
  contents.on('will-redirect', (event, target) => { if (!allowedUrl(target)) event.preventDefault(); });
  contents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame) { navigation++; loadFailed = false; if (!inPlace) documentCommitted = false; }
  });
  contents.on('did-navigate', () => { documentCommitted = true; });
  contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) { loadFailed = true; status('页面加载失败，可刷新页面后重试'); }
  });
  contents.on('render-process-gone', () => { loadFailed = true; status('页面已停止响应，可刷新页面后重试'); });
  const inspect = async () => {
    if (probeExpired && !revealed) throw Object.assign(verificationPaused(), { message: '页面访问检查超时，任务已暂停，进度已保留；请检查网络后继续采集' });
    if (loadFailed || !documentCommitted) return { ready: false, error: loadFailed };
    const version = navigation;
    // executeJavaScript waits for the load event, which Alibaba images/iframes
    // can hold open indefinitely. Inspect the committed DOM independently.
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
    const result = await contents.debugger.sendCommand('Runtime.evaluate', {
      expression: `(${inspectVerificationDocument.toString()})()`, returnByValue: true,
    });
    if (result.exceptionDetails || !result.result?.value) return { ready: false };
    const state = result.result.value;
    if (state.challenge && version === navigation && documentCommitted && !revealed) {
      revealed = true;
      clearTimeout(probeTimer);
      window.setSkipTaskbar(false);
      window.show(); window.focus();
    }
    return { ...state, ready: state.ready && version === navigation && documentCommitted, url: `${state.url}#navigation-${navigation}` };
  };
  try {
    // The challenge belongs to the requesting browser's current cookie state.
    // An older seller-session copy can load a different (healthy) page while
    // leaving the actual collector challenge unresolved.
    for (const cookie of requestCookies) {
      const domain = String(cookie.domain || '').replace(/^\./, '');
      if (!/(^|\.)(?:alibaba\.com|1688\.com|aliexpress\.com|alicdn\.com)$/.test(domain)) continue;
      const nextCookie = { url: `https://${domain}${cookie.path || '/'}`,
        name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path || '/',
        secure: cookie.secure, httpOnly: cookie.httpOnly,
        ...(cookie.expires > 0 ? { expirationDate: cookie.expires } : {}),
        sameSite: ({ None: 'no_restriction', Lax: 'lax', Strict: 'strict' })[cookie.sameSite] || 'unspecified',
      };
      await contents.session.cookies.set(nextCookie).catch(async (error) => {
        if (!/EXCLUDE_OVERWRITE_HTTP_ONLY/.test(error.message)) throw error;
        await contents.session.cookies.set({ ...nextCookie, httpOnly: true });
      });
    }
    await window.loadFile(path.join(directory, 'verification.html'));
    onCreated({ window, contents, refresh, inspect });
    // The authenticated partition may already show a healthy product even
    // when the background collector was challenged. Keep that probe hidden.
    probeTimer = setTimeout(() => { probeExpired = true; }, 60000);
    // did-fail-load tracks the active navigation; a replaced load rejects too.
    contents.loadURL(url).catch(() => {});
    await waitForVerification({ inspect, isClosed: closed, shouldStop: () => paused || shouldStop(),
      onWaiting: (message) => {
        if (probeExpired && !revealed) throw Object.assign(verificationPaused(), { message: '页面访问检查超时，任务已暂停，进度已保留；请检查网络后继续采集' });
        status(message); onWaiting(revealed ? message : '正在检查页面访问状态');
      } });
    if (paused || shouldStop()) throw verificationPaused();
    await saveSession({ webContents: contents, readStorage: async () => {
      const response = await contents.debugger.sendCommand('Runtime.evaluate', {
        expression: 'Object.fromEntries(Object.entries(localStorage))', returnByValue: true,
      });
      return response.result?.value || {};
    } });
    return { verified: true, url: contents.getURL() };
  } finally {
    clearTimeout(probeTimer);
    sessions.delete(senderId);
    if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
    if (!contents.isDestroyed()) contents.close();
    if (!window.isDestroyed()) window.destroy();
  }
}
