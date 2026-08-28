import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

function existing(paths) {
  return paths.find((candidate) => candidate && fs.existsSync(candidate));
}

export function findChromium() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const packagedRoot = process.resourcesPath && path.dirname(process.resourcesPath);
  const direct = existing([
    process.env.CHROME_PATH,
    packagedRoot && path.join(process.resourcesPath, 'chromium', 'chrome-win', 'chrome.exe'),
    packagedRoot && path.join(process.resourcesPath, 'chromium', 'chrome-win64', 'chrome.exe'),
    packagedRoot && path.join(packagedRoot, 'chromium', 'chrome-win', 'chrome.exe'),
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
    throw new Error('未找到可用浏览器，请安装 Chrome，或执行 npx playwright install chromium');
  }
  fs.mkdirSync(profileDir, { recursive: true });
  return chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: options.headless ?? false,
    viewport: options.headless ? { width: 1440, height: 1000 } : null,
    locale: options.locale || 'zh-CN',
    args: ['--disable-blink-features=AutomationControlled', '--start-minimized'],
    ...options
  });
}

async function setWindowState(page, windowState) {
  if (!page || page.isClosed()) return false;
  try {
    const session = await page.context().newCDPSession(page);
    const target = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', { windowId: target.windowId, bounds: { windowState } });
    await session.detach().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export async function revealPage(page) {
  const changed = await setWindowState(page, 'normal');
  if (changed) await page.bringToFront().catch(() => {});
  return changed;
}

export async function hidePage(page) {
  return setWindowState(page, 'minimized');
}

export async function isHumanVerificationPage(page) {
  if (!page || page.isClosed()) return false;
  const url = page.url();
  const text = await page.locator('body').innerText().catch(() => '');
  return /captcha|verify|slide to verify|security verification|人机验证|安全验证|滑块|请完成验证|登录失效|login|passport|sign in/i.test(`${url} ${text}`);
}

export async function waitForHumanVerification(page, options = {}) {
  if (!await isHumanVerificationPage(page)) return false;
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
  return false;
}

export async function settlePage(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
  await page.waitForTimeout(1200);
}
