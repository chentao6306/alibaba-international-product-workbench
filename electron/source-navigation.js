const pending = new WeakMap();

export function sourceProductUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error('来源商品链接无效'); }
  if (!/^https?:$/.test(url.protocol) || !/(^|\.)alibaba\.com$/i.test(url.hostname)
    || !/^\/product-detail\//i.test(url.pathname) || url.username || url.password) {
    throw new Error('仅支持打开阿里巴巴国际站来源商品');
  }
  return url.href;
}

export function navigateSourceWindow(window, url, { timeoutMs = 60000 } = {}) {
  const target = sourceProductUrl(url);
  const contents = window.webContents;
  pending.get(window)?.();
  // Display before navigation: a redirect may cancel loadURL, and a challenge
  // must remain visible even when the final page has not finished loading.
  window.setSkipTaskbar(false);
  window.show();
  if (window.isMinimized()) window.restore();
  window.maximize();
  window.focus();
  return new Promise((resolve, reject) => {
    let settled = false;
    let committed = false;
    let timer;
    let readyTimer;
    const finish = (error, superseded = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(readyTimer);
      for (const [name, handler] of events) contents.removeListener(name, handler);
      if (pending.get(window) === supersede) pending.delete(window);
      if (error) reject(error);
      else resolve({ browserOpen: !contents.isDestroyed(), visible: !window.isDestroyed() && window.isVisible(),
        currentUrl: contents.isDestroyed() ? '' : contents.getURL(), onAlibabaInternational: true, ...(superseded ? { superseded: true } : {}) });
    };
    const supersede = () => finish(null, true);
    const failure = (message) => finish(new Error(message));
    const ready = () => {
      if (!committed || contents.isDestroyed()) return;
      let current;
      try { current = new URL(contents.getURL()); } catch { return; }
      if (/^https?:$/.test(current.protocol) && /(^|\.)alibaba\.com$/i.test(current.hostname)) {
        clearTimeout(readyTimer);
        readyTimer = setTimeout(() => { if (committed && !contents.isDestroyed() && contents.getURL() === current.href) finish(); }, 200);
      }
    };
    const events = [
      ['did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) { committed = false; clearTimeout(readyTimer); } }],
      ['did-navigate', () => { committed = true; }],
      ['dom-ready', ready],
      ['did-finish-load', ready],
      ['did-fail-load', (_event, code, description, _url, mainFrame) => {
        if (mainFrame && code !== -3) failure(`来源商品页面加载失败（${description || code}），请在已打开的窗口中重试`);
      }],
      ['render-process-gone', () => failure('来源商品页面停止响应，请重新打开产品链接')],
      ['destroyed', () => failure('来源商品窗口已关闭')],
    ];
    for (const [name, handler] of events) contents.on(name, handler);
    pending.set(window, supersede);
    timer = setTimeout(() => failure('来源商品页面加载超时，请在已打开的窗口中检查网络、登录或验证码'), timeoutMs);
    Promise.resolve().then(() => window.loadURL(target)).then(ready).catch(error => {
      // ERR_ABORTED is also emitted for a successful replacement navigation.
      // Only a committed, ready document above can turn it into success.
      if (error?.errno !== -3 && error?.code !== 'ERR_ABORTED' && !/ERR_ABORTED/.test(error?.message || '')) {
        failure(`来源商品页面加载失败：${error.message}`);
      }
    });
  });
}
