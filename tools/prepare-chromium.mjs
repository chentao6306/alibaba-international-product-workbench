import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'vendor', 'chromium');
const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const configured = process.env.KUA_YIPU_CHROMIUM_SOURCE || '';
const playwrightRoot = path.join(localAppData, 'ms-playwright');
const browserManifest = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8'));
const chromiumDescriptor = browserManifest.browsers.find((browser) => browser.name === 'chromium');
if (!chromiumDescriptor?.revision) throw new Error('无法读取 Playwright Chromium revision');
const cacheDirectory = path.join(playwrightRoot, `chromium-${chromiumDescriptor.revision}`);
const cachedCandidates = [
  path.join(cacheDirectory, 'chrome-win'),
  path.join(cacheDirectory, 'chrome-win64')
];
const candidates = [configured, ...cachedCandidates].filter(Boolean);

const source = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'chrome.exe')));
if (!source) {
  throw new Error(`未找到与 Playwright 匹配的 Chromium ${chromiumDescriptor.browserVersion} (revision ${chromiumDescriptor.revision})。请先执行 npx playwright install chromium，或设置 KUA_YIPU_CHROMIUM_SOURCE。`);
}

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.cpSync(source, destination, { recursive: true });
const executable = path.join(destination, 'chrome.exe');
const bytes = fs.statSync(executable).size;
console.log(`Bundled Chromium ${chromiumDescriptor.browserVersion} revision ${chromiumDescriptor.revision}: ${executable} (${Math.round(bytes / 1024 / 1024)} MB chrome.exe)`);
