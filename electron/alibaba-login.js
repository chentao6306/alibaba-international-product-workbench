import { alibabaLoginPage } from './alibaba-login-page.js';

const CREDENTIAL_ERROR = '阿里巴巴提示：账号或密码不正确。请在软件登录页重新输入 Alibaba 账号和密码后重试。软件授权码不能代替阿里巴巴密码。';
const isAlibabaPage = (url) => {
  try { const page = new URL(url); return page.protocol === 'https:' && /(^|\.)alibaba\.com$/i.test(page.hostname); } catch { return false; }
};
const isEnterUrl = (url) => {
  try { const page = new URL(url); return page.protocol === 'kua-yipu:' && page.hostname === 'enter'; } catch { return false; }
};

export function rememberedLoginCredentials(username, password, result, previous) {
  const sameAccount = String(previous?.username || '').trim().toLowerCase() === String(username).trim().toLowerCase();
  return { username, password: result.rememberPassword ? password
    : result.reuseRememberedPassword && sameAccount ? String(previous.password || '') : '' };
}

export function loginWithAlibaba(login, { username, password, matchesSession, checkAuthorization, onVerified,
  saveSession, enterSystem, onStatus = () => {}, onCredentialsRejected = () => {},
  pollMs = 500, timeoutMs = 600000, fieldDelayMs = 900, submitDelayMs = 2200 }) {
  const contents = login.webContents;
  let settled = false;
  let succeeded = false;
  let inspecting = false;
  let entering = false;
  let autoAttempted = false;
  let autoSubmitted = false;
  let needsManualLogin = false;
  let credentialsRejected = false;
  let credentialsEdited = false;
  let generation = 0;
  let status = '';
  let lastError = '';
  let timer;
  let timeout;
  let resolve;
  let reject;
  const result = new Promise((yes, no) => { resolve = yes; reject = no; });
  const alive = () => !login.isDestroyed() && !contents.isDestroyed();
  const active = () => !settled && alive();
  const page = (action, payload) => {
    if (!alive() || !isAlibabaPage(contents.getURL())) return Promise.resolve(null);
    return contents.executeJavaScript(`(${alibabaLoginPage.toString()})(${JSON.stringify(action)}, ${JSON.stringify(payload || {})})`, true);
  };
  const message = async (value, { error = false, canEnter = false } = {}) => {
    if (status !== value) { status = value; onStatus(value); }
    await page('message', { message: value, error, canEnter }).catch(() => {});
  };
  const show = () => { if (alive()) { if (login.isMinimized()) login.restore(); login.show(); login.focus(); } };
  const cleanup = () => {
    clearInterval(timer);
    clearTimeout(timeout);
    contents.removeListener('did-finish-load', onFinishLoad);
    contents.removeListener('did-fail-load', onFailLoad);
    contents.removeListener('did-start-navigation', onNavigation);
  };
  const settle = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) {
      login.removeListener('closed', onClosed);
      contents.removeListener('will-navigate', onWillNavigate);
      if (alive()) login.close();
      reject(error);
    } else resolve({ url: contents.getURL(), rememberPassword: autoSubmitted && !credentialsEdited,
      reuseRememberedPassword: !autoSubmitted && !credentialsEdited });
  };
  const onClosed = () => {
    contents.removeListener('will-navigate', onWillNavigate);
    if (!succeeded) settle(new Error(lastError || '已取消阿里巴巴登录，请重新登录'));
  };
  const rejectCredentials = () => {
    needsManualLogin = true;
    autoAttempted = true;
    lastError = CREDENTIAL_ERROR;
    if (!credentialsRejected) {
      credentialsRejected = true;
      try { onCredentialsRejected(); } catch {}
    }
    settle(new Error(CREDENTIAL_ERROR));
  };
  const verify = async (state) => {
    const documentGeneration = generation;
    if (!active() || state.hasLoginForm || !state.rendered || !await matchesSession()) return false;
    await checkAuthorization();
    if (!active() || documentGeneration !== generation) return false;
    await saveSession();
    if (!active() || documentGeneration !== generation) return false;
    await message('Alibaba 登录成功', { canEnter: true });
    if (!active() || documentGeneration !== generation) return false;
    onVerified();
    succeeded = true;
    settle();
    return true;
  };
  const inspect = async () => {
    if (!active() || inspecting) return;
    inspecting = true;
    try {
      const documentGeneration = generation;
      const state = await page('status');
      if (!state || !active() || documentGeneration !== generation) return;
      if (state.credentialsEdited) { needsManualLogin = true; credentialsEdited = true; }
      if (state.credentialError) {
        rejectCredentials();
        return;
      }
      if (state.challenge) {
        needsManualLogin = true;
        autoAttempted = true;
        const prompt = '请在阿里巴巴窗口完成人工验证，验证后继续登录。';
        if (status !== prompt) show();
        await message(prompt);
        return;
      }
      if (state.hasLoginForm) {
        if (state.interacted) { autoAttempted = true; needsManualLogin = true; }
        await message(needsManualLogin ? '请完成阿里巴巴验证；进入系统前仍会核对授权账号。' : '正在等待阿里巴巴登录，请勿重复点击。');
        const currentPage = new URL(contents.getURL());
        const loginRoute = /login|passport|signin/i.test(currentPage.hostname + currentPage.pathname);
        if (state.ready && loginRoute && !autoAttempted) {
          autoAttempted = true;
          const sameDocument = () => active() && documentGeneration === generation;
          const accountSet = await page('account', { value: username });
          await new Promise((done) => setTimeout(done, fieldDelayMs));
          if (!sameDocument()) return;
          const passwordSet = accountSet && await page('password', { value: password });
          await new Promise((done) => setTimeout(done, submitDelayMs));
          if (!sameDocument()) return;
          autoSubmitted = Boolean(accountSet && passwordSet && await page('submit', { username, password }));
          if (!autoSubmitted) {
            needsManualLogin = true;
            // The user may have started a CAPTCHA while the fields were being
            // filled. Keep that verification, but never submit partial values.
            const afterFill = await page('status');
            if (afterFill?.credentialError) rejectCredentials();
            else if (!afterFill?.challenge && !afterFill?.interacted) settle(new Error('阿里巴巴登录表单尚未准备好或自动填写未成功，请重新登录。'));
          }
        }
        return;
      }
      if (!await verify(state) && active() && state.rendered) {
        await message('尚未确认授权账号的阿里巴巴登录状态，请使用与软件授权一致的账号。', { error: true });
      }
    } catch (error) {
      // Navigation can destroy the JS execution context. Keep the window and
      // let the next document be inspected rather than treating it as failure.
      if (active() && !/context|destroyed|frame|navigation/i.test(error.message || '')) {
        settle(new Error(`登录校验未完成：${error.message || '请重新登录'}`));
      }
    } finally { inspecting = false; }
  };
  const requestEnter = async () => {
    if (entering || !alive() || (settled && !succeeded)) return;
    entering = true;
    try {
      if (!succeeded) await inspect();
      if (!succeeded) return;
      await enterSystem();
    } catch (error) { await message(error.message || '进入工作台失败，请重试', { error: true, canEnter: succeeded }); }
    finally { entering = false; }
  };
  const onWillNavigate = (event, url) => {
    if (isEnterUrl(url)) { event.preventDefault(); void requestEnter(); }
  };
  const onNavigation = (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) generation++;
  };
  const onFinishLoad = () => { void inspect(); };
  const onFailLoad = (_event, code, description, _url, isMainFrame) => {
    if (!active() || !isMainFrame || code === -3) return;
    lastError = `阿里巴巴登录页加载失败（${description || code}），请检查网络后关闭此窗口并重试。`;
    settle(new Error(lastError));
  };
  login.once('closed', onClosed);
  contents.on('will-navigate', onWillNavigate);
  contents.on('did-start-navigation', onNavigation);
  contents.on('did-fail-load', onFailLoad);
  contents.on('did-finish-load', onFinishLoad);
  contents.setWindowOpenHandler(({ url }) => {
    if (isEnterUrl(url)) { void requestEnter(); return { action: 'deny' }; }
    try { return { action: /^https?:$/.test(new URL(url).protocol) ? 'allow' : 'deny' }; } catch { return { action: 'deny' }; }
  });
  timer = setInterval(() => { void inspect(); }, pollMs);
  timeout = setTimeout(() => settle(new Error(lastError || '阿里巴巴登录等待超时，请重新登录')), timeoutMs);
  void message('正在打开阿里巴巴登录页面…');
  void login.loadURL('https://login.alibaba.com/').catch((error) => {
    if (!active() || error.code === 'ERR_ABORTED' || error.errno === -3 || /ERR_ABORTED/.test(error.message || '')) return;
    onFailLoad(null, error.errno, error.code || '网络连接中断', '', true);
  });
  return result;
}
