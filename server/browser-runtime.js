import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const contextModes = new WeakMap();

function cookieFile() {
  return process.env.KUA_YIPU_ALIBABA_COOKIES_FILE || '';
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
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return normalizeAlibabaCookies(raw);
  } catch {
    return [];
  }
}

export async function syncAlibabaCookies(context) {
  const cookies = readAlibabaCookies();
  if (!cookies.length) return;
  await context.addCookies(cookies).catch(() => {});
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
  const executablePath = findChromium();
  if (!executablePath) {
    if (process.env.KUA_YIPU_REQUIRE_BUNDLED_BROWSER === '1') {
      throw new Error('安装包缺少内置 Chromium，请重新安装完整客户端');
    }
    throw new Error('未找到可用浏览器，请安装 Chrome，或执行 npx playwright install chromium');
  }
  fs.mkdirSync(profileDir, { recursive: true });
  const headless = options.headless === true;
  const hiddenWindowArgs = headless ? [] : [
    '--window-position=-32000,-32000',
    // Keep a real viewport during hidden automation. A 1x1/minimized window
    // makes Playwright reject otherwise valid interactions as outside the
    // viewport and can expose a transient browser taskbar entry.
    '--window-size=1280,900'
  ];
  const launchOptions = {
    executablePath,
    headless,
    viewport: null,
    locale: options.locale || 'zh-CN',
    // Keep the headed browser completely off-screen during automation. A
    // headed context is still required because Alibaba may request a human
    // verification; revealPage() moves it back on-screen only then.
    args: [
      '--disable-blink-features=AutomationControlled',
      ...hiddenWindowArgs,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble'
    ],
    ...options,
    headless,
    viewport: null,
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
    contextModes.set(context, { headless });
    await syncAlibabaCookies(context);
    return context;
  } catch (error) {
    const message = String(error?.message || '');
    if (/user data directory is already in use|profile is in use|SingletonLock/i.test(message)) {
      const recoveryDir = `${profileDir}-session-${process.pid}-${Date.now()}`;
      fs.mkdirSync(recoveryDir, { recursive: true });
      try {
        const context = await chromium.launchPersistentContext(recoveryDir, launchOptions);
        contextModes.set(context, { headless });
        await syncAlibabaCookies(context);
        return context;
      } catch {}
    }
    if (/Target page, context or browser has been closed|browser has been closed/i.test(message)) {
      const browserName = path.basename(executablePath);
      throw new Error(`内置浏览器启动后立即退出（${browserName}，配置目录：${profileDir}）。请关闭旧的跨易铺进程后重试。原始原因：${message.slice(0, 240)}`);
    }
    throw new Error('采集浏览器启动失败，请检查本机浏览器后重试');
  }
}

async function setWindowState(page, windowState, bounds = {}) {
  if (!page || page.isClosed()) return false;
  try {
    const session = await page.context().newCDPSession(page);
    const target = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', { windowId: target.windowId, bounds: { windowState, ...bounds } });
    await session.detach().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export async function revealPage(page) {
  // Verification is the only time the automation window is user-visible.
  // Maximize it so the challenge cannot be hidden behind the workbench.
  const changed = await setWindowState(page, 'maximized');
  if (changed) await page.bringToFront().catch(() => {});
  return changed;
}

export async function hidePage(page) {
  if (!page || page.isClosed()) return false;
  // Keep a real viewport while moving the native window off-screen. Resizing
  // to 1x1 (the old implementation) makes Playwright reject normal clicks as
  // "outside of the viewport" during publishing.
  return setWindowState(page, 'normal', { x: -32000, y: -32000, width: 1280, height: 900 });
}

export async function isHumanVerificationPage(page) {
  if (!page || page.isClosed()) return false;
  const url = page.url();
  const text = await page.locator('body').innerText().catch(() => '');
  const verificationText = /captcha|滑块|请完成验证|人机验证|安全验证|security verification|slide to verify|verify you are human|登录失效/i.test(text);
  const authUrl = /(^|\/)(login|passport|signin|sign-in)([/?#]|$)/i.test(url);
  return verificationText || authUrl;
}

export async function waitForHumanVerification(page, options = {}) {
  // Alibaba's punishment page often paints after domcontentloaded. A single
  // immediate check races that render and causes the CAPTCHA document to be
  // parsed as a product page (all detail fields then appear empty).
  let verificationVisible = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    verificationVisible = await isHumanVerificationPage(page);
    if (verificationVisible) break;
    if (attempt < 3) await page.waitForTimeout(400);
  }
  if (!verificationVisible) return false;
  const text = await page.locator('body').innerText().catch(() => '');
  const challenge = /captcha|滑块|请完成验证|人机验证|安全验证|security verification|slide to verify|verify you are human|登录失效/i.test(text);
  if (contextModes.get(page.context())?.headless) {
    // A plain Alibaba login redirect is handled as an unavailable detail page
    // by the caller. Only an actual challenge should interrupt headless work.
    if (!challenge) return false;
    const error = new Error('需要人工验证');
    error.code = 'HUMAN_VERIFICATION_REQUIRED';
    error.verificationUrl = page.url();
    throw error;
  }
  // A normal login redirect is not a human challenge. Treat it as an
  // unavailable authenticated page without revealing the off-screen browser;
  // only actual captcha text below should interrupt automation.
  if (!challenge) return false;
  await revealPage(page);
  const timeout = Math.max(30000, Number(options.timeout || 300000));
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    if (!await isHumanVerificationPage(page)) {
      await hidePage(page);
      return true;
    }
  }
  const error = new Error('验证码未完成，采集已暂停，请完成验证后继续');
  error.code = 'COLLECT_PAUSED';
  throw error;
}

export async function settlePage(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
  await page.waitForTimeout(1200);
}
