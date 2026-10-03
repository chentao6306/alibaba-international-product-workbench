import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { loginWithAlibaba, rememberedLoginCredentials } from '../electron/alibaba-login.js';
import { alibabaLoginPage } from '../electron/alibaba-login-page.js';
import { matchesAlibabaSession, checkAlibabaLoginAccount } from '../electron/alibaba-identity.js';

let browser;
before(async () => { browser = await chromium.launch({ executablePath: findChromium(), headless: true }); });
after(async () => { await browser?.close(); });
const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const form = `<h1>Alibaba.com sign in</h1><div>Sign in to your account</div>
  <form onsubmit="event.preventDefault(); window.submits=(window.submits||0)+1">
    <input name="account"><input name="password" type="password"><button type="submit">Sign in</button>
  </form>`;
const home = '<header>Alibaba.com</header><main>Welcome back to your Alibaba account</main><footer>Products</footer>';
const cookie = (account) => [{ name: 'xman_us_t', value: `sign=y&x_lid=${account}`, domain: '.alibaba.com' }];
async function until(check) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await pause(); }
  assert.fail('Login condition did not become true');
}
async function fixture(t, html = form, options = {}) {
  const page = await browser.newPage();
  t.after(() => page.close());
  const contents = new EventEmitter();
  const window = new EventEmitter();
  let url = 'about:blank';
  let destroyed = false;
  let openHandler;
  const counts = { verified: 0, saved: 0, rejected: 0, entered: 0, checked: 0 };
  const messages = [];
  let cookies = [];
  Object.assign(contents, { isDestroyed: () => destroyed, getURL: () => url,
    executeJavaScript: (code) => page.evaluate(code), setWindowOpenHandler: (handler) => { openHandler = handler; } });
  const navigate = async (target, content) => {
    contents.emit('did-start-navigation', {}, target, false, true);
    url = target;
    await page.setContent(content);
    contents.emit('did-finish-load');
  };
  Object.assign(window, { webContents: contents, isDestroyed: () => destroyed, isMinimized: () => false,
    show() {}, focus() {}, restore() {}, close() { destroyed = true; window.emit('closed'); },
    loadURL: (target) => navigate(target, html) });
  t.after(() => { if (!destroyed) window.close(); });
  const pending = loginWithAlibaba(window, { username: 'licensed-account', password: 'test-password',
    matchesSession: async () => checkAlibabaLoginAccount(cookies, 'licensed-account', url),
    checkAuthorization: async () => { counts.checked++; }, onVerified: () => { counts.verified++; },
    saveSession: async () => { counts.saved++; }, enterSystem: async () => { counts.entered++; },
    onCredentialsRejected: () => { counts.rejected++; }, onStatus: (message) => messages.push(message),
    pollMs: 10, timeoutMs: 5000, fieldDelayMs: 2, submitDelayMs: 2, ...options });
  // Preserve the rejection for assertions without an unhandled-rejection race.
  pending.catch(() => {});
  return { page, contents, window, pending, counts, messages, navigate,
    setCookies(value) { cookies = value; }, open: (target) => openHandler({ url: target }) };
}

test('closes the Alibaba window on rejected credentials and returns the actual reason', async (t) => {
  const f = await fixture(t, `${form}<div role="alert">Your account name or password is incorrect.</div>`);
  await assert.rejects(f.pending, /阿里巴巴提示：账号或密码不正确/);
  assert.equal(f.window.isDestroyed(), true);
  assert.equal(f.counts.rejected, 1);
  assert.equal(f.counts.verified, 0);
  assert.equal(f.counts.checked, 0);
  assert.equal(await f.page.evaluate(() => window.submits || 0), 0);
  assert.equal(f.contents.listenerCount('did-finish-load'), 0);
});

test('waits for a delayed visible form, dispatches input events, and submits only once', async (t) => {
  const f = await fixture(t, '<div>Loading…</div>');
  await pause(40);
  await f.page.setContent(`<form hidden><input name="account"><input name="password" type="password"><button type="submit">Hidden</button></form>${form}
    <script>window.inputs=[];document.addEventListener('input',event=>window.inputs.push(event.target.name));</script>`);
  await until(async () => await f.page.evaluate(() => window.submits === 1));
  assert.deepEqual(await f.page.locator('form:not([hidden]) input').evaluateAll((nodes) => nodes.map((node) => node.value)), ['licensed-account', 'test-password']);
  assert.deepEqual(await f.page.locator('form[hidden] input').evaluateAll((nodes) => nodes.map((node) => node.value)), ['', '']);
  assert.deepEqual(await f.page.evaluate(() => window.inputs), ['account', 'password']);
  f.contents.emit('did-finish-load');
  await pause(60);
  assert.equal(await f.page.evaluate(() => window.submits), 1);
  await f.page.locator('body').evaluate((body) => body.insertAdjacentHTML('beforeend', '<p>账号或密码错误</p>'));
  await assert.rejects(f.pending, /账号或密码不正确/);
  assert.equal(f.window.isDestroyed(), true);
});

test('does not submit when a rerender clears an already filled field', async (t) => {
  const f = await fixture(t, `${form}<script>document.querySelector('[name=password]').addEventListener('input',()=>document.querySelector('[name=account]').value='');</script>`);
  await assert.rejects(f.pending, /自动填写未成功/);
  assert.equal(await f.page.evaluate(() => window.submits || 0), 0);
  assert.equal(f.window.isDestroyed(), true);
});

test('does not automatically fill or submit password fields outside an Alibaba login route', async (t) => {
  const f = await fixture(t, '<div>Loading…</div>');
  await f.navigate('https://www.alibaba.com/account/settings', form);
  await pause(60);
  assert.deepEqual(await f.page.locator('form input').evaluateAll((nodes) => nodes.map((node) => node.value)), ['', '']);
  assert.equal(await f.page.evaluate(() => window.submits || 0), 0);
  f.window.close();
  await assert.rejects(f.pending, /已取消/);
});

test('a successful page for a different account cannot authorize or enter the software', async (t) => {
  const f = await fixture(t, '<div>Loading…</div>');
  f.setCookies(cookie('different-account'));
  await f.navigate('https://www.alibaba.com/', home);
  await assert.rejects(f.pending, /实际登录账号与软件授权账号不一致/);
  f.open('kua-yipu://enter');
  await pause(80);
  assert.equal(f.counts.verified, 0);
  assert.equal(f.counts.entered, 0);
  assert.equal(f.counts.checked, 0);
  assert.equal(f.window.isDestroyed(), true);
});

test('verifies the matching account and software authorization before enabling entry', async (t) => {
  const f = await fixture(t);
  await until(async () => await f.page.evaluate(() => window.submits === 1));
  f.setCookies(cookie('licensed-account'));
  await f.navigate('https://www.alibaba.com/', home);
  const result = await f.pending;
  assert.equal(result.rememberPassword, true);
  assert.deepEqual(f.counts, { verified: 1, saved: 1, rejected: 0, entered: 0, checked: 1 });
  assert.equal(await f.page.locator('#__kua_yipu_enter').isVisible(), true);
  f.open('kua-yipu://enter');
  await until(() => f.counts.entered === 1);
});

test('retains CAPTCHA verification and never treats it as a successful login or credential rejection', async (t) => {
  const f = await fixture(t, `${form}<div>请完成安全验证</div>`);
  await until(() => f.messages.some((message) => message.includes('人工验证')));
  assert.equal(f.window.isDestroyed(), false);
  assert.equal(f.counts.verified, 0);
  assert.equal(f.counts.rejected, 0);
  assert.equal(await f.page.evaluate(() => window.submits || 0), 0);
  f.setCookies(cookie('licensed-account'));
  await f.navigate('https://www.alibaba.com/', home);
  const result = await f.pending;
  assert.deepEqual(rememberedLoginCredentials('licensed-account', 'unverified-password', result), { username: 'licensed-account', password: '' });
});

test('does not overwrite a user edit or click submit during delayed automatic filling', async (t) => {
  const f = await fixture(t, form, { fieldDelayMs: 150 });
  await until(async () => await f.page.locator('[name=account]').inputValue() === 'licensed-account');
  await f.page.locator('[name=account]').fill('different-account');
  await pause(200);
  assert.equal(await f.page.locator('[name=account]').inputValue(), 'different-account');
  assert.equal(await f.page.evaluate(() => window.submits || 0), 0);
  f.window.close();
  await assert.rejects(f.pending, /已取消/);
});

test('does not turn an aborted redirect into a login failure, but reports real network errors', async (t) => {
  const f = await fixture(t, '<div>Loading…</div>');
  f.contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://login.alibaba.com/', true);
  await pause(30);
  assert.equal(f.window.isDestroyed(), false);
  f.contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://login.alibaba.com/', true);
  await assert.rejects(f.pending, /登录页加载失败（ERR_NAME_NOT_RESOLVED）/);
  assert.equal(f.window.isDestroyed(), true);
});

test('a cancellation during authorization cannot verify the session after the window closes', async (t) => {
  let release;
  let started = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, '<div>Loading…</div>', { checkAuthorization: async () => { started = true; await gate; } });
  f.setCookies(cookie('licensed-account'));
  await f.navigate('https://www.alibaba.com/', home);
  await until(() => started);
  f.window.close();
  await assert.rejects(f.pending, /已取消/);
  release();
  await pause(20);
  assert.equal(f.counts.verified, 0);
  assert.equal(f.counts.saved, 0);
});

test('software authorization rejection closes the window without marking the account verified', async (t) => {
  const f = await fixture(t, '<div>Loading…</div>', { checkAuthorization: async () => { throw new Error('软件授权已停用'); } });
  f.setCookies(cookie('licensed-account'));
  await f.navigate('https://www.alibaba.com/', home);
  await assert.rejects(f.pending, /软件授权已停用/);
  assert.equal(f.counts.verified, 0);
  assert.equal(f.window.isDestroyed(), true);
});

test('times out with a specific reason and closes the unfinished login window', async (t) => {
  const f = await fixture(t, '<div>Loading…</div>', { timeoutMs: 80 });
  await assert.rejects(f.pending, /登录等待超时/);
  assert.equal(f.window.isDestroyed(), true);
});

test('hidden credential errors do not invalidate the visible form and status messages cannot feed back into detection', async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setContent(`${form}<div hidden>Your account name or password is incorrect.</div>`);
  const run = (action, payload = {}) => page.evaluate(`(${alibabaLoginPage.toString()})(${JSON.stringify(action)},${JSON.stringify(payload)})`);
  assert.equal((await run('status')).credentialError, false);
  await run('message', { message: '账号或密码错误' });
  assert.equal((await run('status')).credentialError, false);
});

test('entry-time account checks reject a session switched after initial successful verification', () => {
  assert.equal(matchesAlibabaSession(cookie('licensed-account'), 'licensed-account', 'https://www.alibaba.com/'), true);
  assert.equal(matchesAlibabaSession(cookie('different-account'), 'licensed-account', 'https://www.alibaba.com/'), false);
  assert.equal(matchesAlibabaSession([...cookie('licensed-account'), ...cookie('different-account')], 'licensed-account', 'https://www.alibaba.com/'), false);
  assert.throws(() => checkAlibabaLoginAccount(cookie('different-account'), 'licensed-account', 'https://www.alibaba.com/'), /不一致/);
  assert.equal(checkAlibabaLoginAccount([], 'licensed-account', 'https://www.alibaba.com/'), false);
  assert.equal(checkAlibabaLoginAccount(cookie('licensed-account'), 'licensed-account', 'https://login.alibaba.com/'), false);
});

test('the software login page displays the platform reason and allows another authorized login attempt', async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  const html = await fs.readFile(new URL('../electron/login.html', import.meta.url), 'utf8');
  await page.setContent(html.replace('<script src="./login.js"></script>', ''));
  await page.evaluate(() => {
    window.kuaYipu = {
      onLoginStatus() {}, loadCredentials: async () => ({ username: 'licensed-account', password: 'test-password' }),
      activationStatus: async () => true,
      login: async () => { throw new Error("Error invoking remote method 'auth:login': Error: 阿里巴巴提示：账号或密码不正确。请在软件登录页重新输入后重试。"); },
    };
  });
  await page.evaluate(await fs.readFile(new URL('../electron/login.js', import.meta.url), 'utf8'));
  await page.locator('#login').click();
  await until(async () => (await page.locator('#error').textContent()).includes('账号或密码不正确'));
  assert.equal((await page.locator('#error').textContent()).includes('Error invoking remote'), false);
  assert.equal(await page.locator('#login').isEnabled(), true);
  assert.equal(await page.locator('#login').textContent(), '登录');
  assert.equal(await page.locator('#expiry').isVisible(), false);
});
