const alive = (window) => window && !window.isDestroyed() && !window.webContents.isDestroyed();
const aborted = (error) => error?.code === 'ERR_ABORTED' || error?.errno === -3 || /^ERR_ABORTED\b/.test(error?.message || '');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function workbenchErrorMessage(error) {
  if (aborted(error)) return '工作台页面切换未完成，请重新加载。';
  const message = String(error?.message || '工作台页面加载失败');
  // Electron errors can embed the entire previous data URL (including another
  // error page). Never recursively put that document back into the next page.
  if (/data:text\/html|%3C(?:!doctype|html)|\bloading ['"]|https?:\/\//i.test(message)) return '工作台页面暂时未能打开，请重新加载。';
  return message.slice(0, 240);
}

export function createWorkbenchStartup({ url, loadingUrl, ensureServer, onError = () => {},
  serviceTimeoutMs = 30000, navigationTimeoutMs = 15000, renderAttempts = 80, retryDelayMs = 350 }) {
  const states = new WeakMap();
  const stateFor = (window) => {
    if (!states.has(window)) states.set(window, { pending: null, generation: 0, failed: false });
    return states.get(window);
  };
  const target = () => typeof url === 'function' ? url() : url;
  const ready = async (window) => {
    if (!alive(window) || window.webContents.getURL() !== target()) return false;
    const rendered = await window.webContents.executeJavaScript("Boolean(document.getElementById('root')?.childElementCount)", true).catch(() => false);
    return Boolean(rendered) && alive(window) && window.webContents.getURL() === target();
  };
  async function serviceReady() {
    let timer;
    try {
      await Promise.race([ensureServer(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('本地工作台服务启动超时，请重试')), serviceTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  function navigate(window) {
    return new Promise((resolve, reject) => {
      const contents = window.webContents;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        contents.removeListener('did-finish-load', onFinish);
        contents.removeListener('did-fail-load', onFail);
        contents.removeListener('render-process-gone', onGone);
        window.removeListener('closed', onClosed);
        error ? reject(error) : resolve();
      };
      const onFinish = () => { if (alive(window) && contents.getURL() === target()) finish(); };
      const onFail = (_event, code, description, validatedUrl, mainFrame) => {
        if (mainFrame === false || (validatedUrl && validatedUrl !== target()) || code === -3) return;
        finish(new Error(`工作台页面加载失败（${code}: ${description || '连接中断'}）`));
      };
      const onGone = (_event, details) => finish(new Error(`工作台渲染进程异常退出（${details?.reason || 'unknown'}）`));
      const onClosed = () => finish(new Error('工作台窗口已关闭'));
      const timer = setTimeout(() => finish(new Error('工作台页面加载超时，请重新加载')), navigationTimeoutMs);
      // Ignored placeholder/subframe events must not consume a once listener.
      contents.on('did-finish-load', onFinish);
      contents.on('did-fail-load', onFail);
      contents.on('render-process-gone', onGone);
      window.on('closed', onClosed);
      Promise.resolve().then(() => window.loadURL(target())).then(onFinish, (error) => {
        // A redirect/reload may cancel loadURL while the replacement succeeds.
        // Keep observing the replacement; do not retry over its navigation.
        if (!aborted(error)) finish(error);
      });
    });
  }
  function showError(window, error) {
    if (!alive(window)) return;
    const state = stateFor(window);
    state.generation++;
    // The retry button navigates directly. A later independent failure must
    // still show its recovery view after that navigation succeeded.
    if (state.failed && window.webContents.getURL().startsWith('data:')) return;
    state.failed = true;
    onError(error);
    const message = workbenchErrorMessage(error).replace(/[<>&"']/g, (value) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[value]));
    const retryUrl = JSON.stringify(target()).replace(/"/g, '&quot;');
    const html = `<!doctype html><meta charset="utf-8"><title>抄得快启动失败</title><style>body{font-family:Microsoft YaHei,sans-serif;margin:0;background:#f4f6f7;color:#182028;display:grid;place-items:center;min-height:100vh}.box{background:#fff;border:1px solid #dfe4e7;border-radius:8px;padding:32px 38px;max-width:620px}h1{font-size:22px;color:#f06423}p{line-height:1.7;color:#59666c;word-break:break-word}button{padding:12px 22px;border:0;border-radius:5px;background:#f06423;color:#fff;font-weight:700;cursor:pointer}</style><main class="box"><h1>工作台暂时未能打开</h1><p>${message}</p><button onclick="location.href=${retryUrl}">重新加载</button></main>`;
    window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
  }
  function start(window) {
    if (!alive(window)) return Promise.resolve(false);
    const state = stateFor(window);
    if (state.pending) return state.pending;
    const generation = ++state.generation;
    state.failed = false;
    const current = () => alive(window) && state.generation === generation;
    // Store the promise before the first asynchronous operation so all login,
    // enter-system and recovery callers share this window's entire startup.
    state.pending = Promise.resolve().then(async () => {
      if (await ready(window)) return true;
      if (!current()) return false;
      if (loadingUrl && !window.webContents.getURL().startsWith('http')) {
        await window.loadURL(typeof loadingUrl === 'function' ? loadingUrl() : loadingUrl).catch((error) => {
          if (!aborted(error)) throw error;
        });
      }
      await serviceReady();
      let lastError;
      for (let attempt = 0; current() && attempt < 3; attempt++) {
        try {
          if (await ready(window)) return true;
          await navigate(window);
          for (let render = 0; current() && render < renderAttempts; render++) {
            if (await ready(window)) return true;
            await wait(125);
          }
          throw new Error('工作台页面未完成渲染，请重新加载');
        } catch (error) {
          lastError = error;
          if (attempt < 2 && current()) await wait(retryDelayMs * (attempt + 1));
        }
      }
      if (current()) throw lastError || new Error('工作台页面加载失败');
      return false;
    }).catch((error) => { if (current()) showError(window, error); return false; })
      .finally(() => { state.pending = null; });
    return state.pending;
  }
  return { start, showError, isStarting: (window) => Boolean(states.get(window)?.pending) };
}
