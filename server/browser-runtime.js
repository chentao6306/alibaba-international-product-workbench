import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { readPrivateSession } from './private-session-storage.js';
import { inspectVerificationDocument, verificationOptions, verificationPaused, waitForVerification } from './human-verification.js';
import { browserStep } from './browser-step.js';
import { nativeBrowserWindows } from './native-browser-window.js';

const contextModes = new WeakMap();
const importedSessions = new WeakMap();

function cookieFile() {
  return process.env.KUA_YIPU_ALIBABA_COOKIES_FILE || '';
}

function storageFile() {
  const file = cookieFile();
  return file ? path.join(path.dirname(file), 'alibaba-storage.json') : '';
}

export function normalizeAlibabaCookies(rawCookies = []) {
  return (Array.isArray(rawCookies) ? rawCookies : []).map((cookie) => ({
    name: String(cookie.name || ''),
    value: String(cookie.value || ''),
    domain: cookie.domain || '.alibaba.com',
    path: cookie.path || '/',
    expires: Number(cookie.expirationDate || cookie.expires || -1),
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
    sameSite: ({ no_restriction: 'None', lax: 'Lax', strict: 'Strict', unspecified: 'Lax' }[String(cookie.sameSite || '').toLowerCase()] || 'Lax')
  })).filter((cookie) => cookie.name && cookie.value);
}

function readAlibabaCookies() {
  const file = cookieFile();
  if (!file || !fs.existsSync(file)) return [];
  try {
    const raw = readPrivateSession(file);
    return normalizeAlibabaCookies(raw);
  } catch {
    return [];
  }
}

export async function syncAlibabaCookies(context, { force = false } = {}) {
  let imported = importedSessions.get(context);
  if (!imported) { imported = { cookies: new Map(), storage: '' }; importedSessions.set(context, imported); }
  const cookies = readAlibabaCookies();
  const key = (cookie) => `${cookie.domain}\n${cookie.path}\n${cookie.name}`;
  // A source browser can receive newer verification cookies itself. Import
  // only values actually changed by desktop login/verification, otherwise each
  // new product request would overwrite the user's just-completed challenge.
  const changed = cookies.filter((cookie) => force || imported.cookies.get(key(cookie)) !== JSON.stringify(cookie));
  if (changed.length) {
    try {
      await context.addCookies(changed);
      for (const cookie of changed) imported.cookies.set(key(cookie), JSON.stringify(cookie));
    } catch {}
  }
  const file = storageFile();
  if (!file || !fs.existsSync(file)) return;
  let storage = {};
  try { storage = readPrivateSession(file); } catch { return; }
  const storageKey = JSON.stringify(storage);
  if (imported.storage === storageKey) return;
  await context.addInitScript((entries) => {
    try {
      if (!/(^|\.)alibaba\.com$/i.test(location.hostname)) return;
      const values = entries[location.origin] || entries['https://www.alibaba.com'];
      if (!values || typeof values !== 'object') return;
      for (const [key, value] of Object.entries(values)) localStorage.setItem(key, String(value));
    } catch {}
  }, storage).then(() => { imported.storage = storageKey; }).catch(() => {});
}

function existing(paths) {
  return paths.find((candidate) => candidate && fs.existsSync(candidate));
}

export function findChromium() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const resources = process.resourcesPath || '';
  // A customer installation must not depend on a particular Edge/Chrome
  // path. electron-builder can unpack a licensed Chromium build under
  // resources/chromium; prefer that copy so the EXE and the web build use the
  // same Playwright runtime. Keep the environment override first for support
  // and diagnostics, then fall back to installed browsers for development.
  const packaged = existing([
    path.join(resources, 'chromium', 'chrome-win', 'chrome.exe'),
    path.join(resources, 'chromium', 'chrome-win64', 'chrome.exe'),
    path.join(resources, 'chromium', 'chrome.exe'),
    path.join(resources, 'app.asar.unpacked', 'chromium', 'chrome-win', 'chrome.exe'),
    path.join(resources, 'app.asar.unpacked', 'chromium', 'chrome-win64', 'chrome.exe'),
    // Development Electron runs from the repository but must use the same
    // bundled engine as the packaged client, never the user's Edge/Chrome.
    path.join(process.env.APP_ROOT_DIR || process.cwd(), 'vendor', 'chromium', 'chrome.exe')
  ]);
  if (packaged) return packaged;
  // Packaged clients must be self-contained. Falling back to a customer's
  // Edge/Chrome silently changes the browser engine and was the source of
  // EXE-only session, upload, and CAPTCHA differences.
  if (process.env.KUA_YIPU_REQUIRE_BUNDLED_BROWSER === '1' || process.env.KUA_YIPU_DESKTOP === '1') return null;
  const direct = existing([
    process.env.KUA_YIPU_CHROMIUM_PATH,
    process.env.CHROME_PATH,
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ]);
  if (direct) return direct;

  const playwrightRoot = path.join(local, 'ms-playwright');
  if (!fs.existsSync(playwrightRoot)) return null;
  const versions = fs.readdirSync(playwrightRoot)
    .filter((name) => name.startsWith('chromium-'))
    .sort().reverse();
  for (const version of versions) {
    const found = existing([
      path.join(playwrightRoot, version, 'chrome-win', 'chrome.exe'),
      path.join(playwrightRoot, version, 'chrome-win64', 'chrome.exe')
    ]);
    if (found) return found;
  }
  return null;
}

export async function launchPersistent(profileDir, options = {}) {
  const { visible = false, backgroundPublishing = false, ...browserOptions } = options;
  const executablePath = findChromium();
  if (!executablePath) {
    if (process.env.KUA_YIPU_REQUIRE_BUNDLED_BROWSER === '1') {
      throw new Error('安装包缺少内置 Chromium，请重新安装完整客户端');
    }
    throw new Error('未找到可用浏览器，请安装 Chrome，或执行 npx playwright install chromium');
  }
  fs.mkdirSync(profileDir, { recursive: true });
  const headless = options.headless === true;
  const hiddenWindowArgs = headless ? [] : visible ? ['--start-maximized'] : [
    '--window-position=-32000,-32000',
    // Keep a real viewport during hidden automation. A 1x1/minimized window
    // makes Playwright reject otherwise valid interactions as outside the
    // viewport and can expose a transient browser taskbar entry.
    '--window-size=1280,900'
  ];
  const launchOptions = {
    executablePath,
    headless,
    viewport: headless ? (options.viewport || { width: 1280, height: 900 }) : null,
    locale: options.locale || 'zh-CN',
    // Headless work has no native window or taskbar entry, while retaining a
    // normal viewport for form layout and lazy-loaded controls.
    args: [
      '--disable-blink-features=AutomationControlled',
      ...hiddenWindowArgs,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble'
    ],
    ...browserOptions,
    headless,
    viewport: headless ? (options.viewport || { width: 1280, height: 900 }) : null,
    args: [...new Set([
      '--disable-blink-features=AutomationControlled',
      ...hiddenWindowArgs,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      ...(options.args || [])
    ])]
  };
  try {
    const context = await chromium.launchPersistentContext(profileDir, launchOptions);
    contextModes.set(context, { headless, visible, backgroundPublishing });
    try { await browserStep(() => syncAlibabaCookies(context), { timeoutMs: 15000, label: '初始化浏览器会话' }); }
    catch (error) { context.close().catch(() => {}); throw error; }
    return context;
  } catch (error) {
    const message = String(error?.message || '');
    if (/user data directory is already in use|profile is in use|SingletonLock/i.test(message)) {
      const recoveryDir = `${profileDir}-session-${process.pid}-${Date.now()}`;
      fs.mkdirSync(recoveryDir, { recursive: true });
      try {
        const context = await chromium.launchPersistentContext(recoveryDir, launchOptions);
        contextModes.set(context, { headless, visible, backgroundPublishing });
        try { await browserStep(() => syncAlibabaCookies(context), { timeoutMs: 15000, label: '初始化恢复浏览器会话' }); }
        catch (error) { context.close().catch(() => {}); throw error; }
        return context;
      } catch {}
    }
    if (/Target page, context or browser has been closed|browser has been closed/i.test(message)) {
      const browserName = path.basename(executablePath);
      throw new Error(`内置浏览器启动后立即退出（${browserName}，配置目录：${profileDir}）。请关闭旧的抄得快进程后重试。原始原因：${message.slice(0, 240)}`);
    }
    throw new Error('采集浏览器启动失败，请检查本机浏览器后重试');
  }
}

async function setWindowState(page, windowState, bounds = {}) {
  if (!page || page.isClosed()) return false;
  let session;
  try {
    session = await page.context().newCDPSession(page);
    const target = await session.send('Browser.getWindowForTarget');
    // Chromium rejects maximizing a minimized/fullscreen window directly on
    // some Windows/RDP sessions. Restore it first; do not discard a working
    // seller session merely because its native window was minimized.
    if (windowState === 'maximized' && ['minimized', 'fullscreen'].includes(target.bounds?.windowState)) {
      await session.send('Browser.setWindowBounds', { windowId: target.windowId, bounds: { windowState: 'normal' } });
    }
    await session.send('Browser.setWindowBounds', { windowId: target.windowId, bounds: { windowState, ...bounds } });
    return true;
  } catch {
    return false;
  } finally {
    await session?.detach().catch(() => {});
  }
}

export async function revealPage(page) {
  if (!page || page.isClosed() || contextModes.get(page.context())?.headless) return false;
  if (contextModes.has(page.context())) await nativeBrowserWindows(page.context(), 'show');
  // Used for both publishing inspection and human verification.
  const changed = await setWindowState(page, 'maximized');
  if (changed) await page.bringToFront().catch(() => {});
  return changed;
}

export async function hidePage(page) {
  if (!page || page.isClosed()) return false;
  if (contextModes.get(page.context())?.headless) return true;
  // Keep a real viewport while moving the native window off-screen. Resizing
  // to 1x1 (the old implementation) makes Playwright reject normal clicks as
  // "outside of the viewport" during publishing.
  const moved = await setWindowState(page, 'normal', { left: -32000, top: -32000, width: 1280, height: 900 });
  // CDP bounds only move the window; Windows still displays its taskbar entry.
  // Hide the owned native windows while keeping the verified browser alive.
  if (contextModes.has(page.context())) await nativeBrowserWindows(page.context(), 'hide');
  return moved;
}

const HUMAN_CHALLENGE_TEXT = /请完成验证|请拖动滑块|滑动验证|滑块验证|人机验证|安全验证|安全校验|security verification|slide to verify|drag (?:the )?slider to verify|verify you are human|complete (?:the )?captcha|unusual traffic/i;

export function isExplicitHumanVerificationSignal(text = '') {
  return HUMAN_CHALLENGE_TEXT.test(String(text || ''));
}

/**
 * Check only explicit, visible challenge signals. A whole Alibaba product
 * page may contain the word "captcha" in auxiliary markup or translations;
 * that word alone must never open a desktop window or pause collection.
 */
export async function hasExplicitHumanChallenge(page) {
  if (!page || page.isClosed()) return false;
  return page.evaluate(inspectVerificationDocument).then((state) => state.challenge).catch(() => false);
}

export async function isHumanVerificationPage(page) {
  if (!page || page.isClosed()) return false;
  const authUrl = /(^|\/)(login|passport|signin|sign-in)([/?#]|$)/i.test(page.url());
  return authUrl || await page.evaluate(inspectVerificationDocument).then((state) => state.challenge || state.pending).catch(() => false);
}

export async function waitForHumanVerification(page, options = {}) {
  const inherited = verificationOptions();
  const shouldStop = () => page.isClosed() || options.shouldStop?.() || inherited.shouldStop?.();
  const onWaiting = (message) => (options.onWaiting || inherited.onWaiting)?.(message);
  // Alibaba's punishment page often paints after domcontentloaded. A single
  // immediate check races that render and causes the CAPTCHA document to be
  // parsed as a product page (all detail fields then appear empty).
  let verificationVisible = await isHumanVerificationPage(page);
  // Only a URL that looks like Alibaba's punishment/verification flow needs
  // a render grace period. Normal product pages get a single cheap check so
  // every collected item does not pay an unnecessary 1.2s polling penalty.
  if (!verificationVisible && /(?:punish|captcha|nocaptcha|verify|verification|x5sec|security)/i.test(page.url())) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.waitForTimeout(350);
      verificationVisible = await isHumanVerificationPage(page);
      if (verificationVisible) break;
    }
  }
  if (!verificationVisible) return false;
  const challenge = await hasExplicitHumanChallenge(page);
  const pending = !challenge && await page.evaluate(inspectVerificationDocument).then((state) => state.pending).catch(() => false);
  if (contextModes.get(page.context())?.headless) {
    // A plain Alibaba login redirect is handled as an unavailable detail page
    // by the caller. Only an actual challenge should interrupt headless work.
    if (!challenge && !pending) return false;
    if (contextModes.get(page.context())?.backgroundPublishing) {
      // Background publishing never opens another taskbar window by itself.
      // Login/verification stays an explicit action in the seller window.
      throw Object.assign(new Error('国际站要求安全验证，请打开卖家窗口完成验证后继续；当前商品进度已保留'), {
        code: 'HUMAN_VERIFICATION_REQUIRED', verificationUrl: page.url(),
      });
    }
    const bridge = globalThis.__KUA_YIPU_SELLER_BRIDGE;
    if (typeof bridge?.humanVerification === 'function') {
      const verificationUrl = page.url();
      for (let attempt = 0; attempt < 2; attempt++) {
        if (shouldStop()) throw verificationPaused();
        onWaiting('等待人工验证，已保存的采集进度保留');
        const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '');
        const requestCookies = await page.context().cookies();
        const handled = await bridge.humanVerification(verificationUrl, { shouldStop, onWaiting, userAgent, requestCookies });
        if (!handled) break;
        if (shouldStop()) throw verificationPaused();
        await syncAlibabaCookies(page.context());
        // A punishment URL may contain an expired challenge token. Resume at
        // the actual healthy destination reached by the verification window.
        let resumeUrl = verificationUrl;
        if (handled.verified && handled.url) {
          try {
            const target = new URL(handled.url);
            if (target.protocol === 'https:' && /(^|\.)(?:alibaba\.com|1688\.com|aliexpress\.com|alicdn\.com)$/.test(target.hostname)) resumeUrl = target.href;
          } catch {}
        }
        onWaiting('验证已完成，正在恢复商品采集');
        await page.goto(resumeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        const deadline = performance.now() + 15000;
        const recheck = () => Object.assign(new Error('采集页面尚未恢复'), { code: 'VERIFICATION_RECHECK_REQUIRED' });
        try {
          await waitForVerification({ inspect: async () => {
            const state = await page.evaluate(inspectVerificationDocument);
            if (state.challenge || performance.now() >= deadline) throw recheck();
            return state;
          }, shouldStop, isClosed: () => page.isClosed(), onWaiting: () => {
            if (performance.now() >= deadline) throw recheck();
            onWaiting('验证已完成，正在恢复商品采集');
          } });
          return true;
        } catch (error) {
          if (error.code !== 'VERIFICATION_RECHECK_REQUIRED') throw error;
        }
      }
      throw Object.assign(new Error('验证会话未能同步，正在恢复原采集浏览器'), {
        code: 'HUMAN_VERIFICATION_REQUIRED', verificationUrl,
      });
    }
    const error = new Error('需要人工验证');
    error.code = 'HUMAN_VERIFICATION_REQUIRED';
    error.verificationUrl = page.url();
    throw error;
  }
  // A normal login redirect is not a human challenge. Treat it as an
  // unavailable authenticated page without revealing the off-screen browser;
  // only actual captcha text below should interrupt automation.
  if (!challenge && !pending) return false;
  let revealed = false;
  try {
    await waitForVerification({
      inspect: async () => {
        const state = await page.evaluate(inspectVerificationDocument);
        if (state.challenge && !revealed) { await revealPage(page); revealed = true; }
        if (revealed && !state.ready) await page.evaluate(() => {
          if (document.getElementById('workbench-human-actions')) return;
          const toolbar = document.createElement('div');
          toolbar.id = 'workbench-human-actions';
          toolbar.style.cssText = 'position:fixed;top:8px;right:16px;z-index:2147483647;padding:10px;background:white;border:1px solid #aabbbc;border-radius:4px;display:flex;gap:12px;font:14px sans-serif';
          const refresh = document.createElement('button');
          refresh.textContent = '刷新页面'; refresh.onclick = () => location.reload();
          toolbar.append(refresh); document.body.append(toolbar);
        });
        return state;
      }, shouldStop, isClosed: () => page.isClosed(), onWaiting
    });
    await page.evaluate(() => document.getElementById('workbench-human-actions')?.remove()).catch(() => {});
    if (!contextModes.get(page.context())?.visible) await hidePage(page);
    return true;
  } catch (error) {
    if (shouldStop()) throw verificationPaused();
    throw error;
  }
}

export async function settlePage(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
  await page.waitForTimeout(1200);
}
