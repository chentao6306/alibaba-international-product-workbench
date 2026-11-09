import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startLocalService } from '../electron/local-service.js';
import { JsonStore } from '../server/store.js';
import { findChromium } from '../server/browser-runtime.js';

// A built UI polling a real worker, with only Electron's read-only replies
// delayed. No customer workspace, account, publication or external API.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-service-ui-qa-'));
const file = path.join(root, 'workspace.json');
new JsonStore(file).update(state => {
  state.products = [{ id: 'idle-fixture', title: 'Synthetic saved product', selected: false,
    source: { title: 'Synthetic original' }, status: 'ready', sourcePlatform: 'alibaba.com' }];
});
let blocked = '', reads = 0, writes = 0;
const replies = [];
const statusReply = method => {
  const value = method === 'authorization' ? { valid: true, canRead: true, account: 'fixture' } : { browserOpen: false };
  return blocked === method ? new Promise(resolve => replies.push(() => resolve(value))) : value;
};
const service = startLocalService({ entry: path.resolve('server/index.js'),
  env: { ...process.env, DATA_DIR: root, PORT: '0', KUA_YIPU_DESKTOP: '1', KUA_YIPU_LOCAL_GATE: 'idle-ui-fixture' },
  handlers: { authorization: () => statusReply('authorization'), 'seller.status': () => statusReply('seller.status') } });
let browser;
const checks = [];
try {
  const port = await service.ready;
  const original = fs.readFileSync(file);
  browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 },
    extraHTTPHeaders: { 'x-kua-yipu-gate': 'idle-ui-fixture' } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/state') reads++;
    if (url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) writes++;
  });
  await page.route('**/api/announcements**', route => route.fulfill({ json: [] }));
  await page.goto(`http://127.0.0.1:${port}/`);
  const footer = page.locator('.sidebar-foot');
  await footer.getByText('运行正常', { exact: true }).waitFor();
  // Let unchanged-state polling run without clicking anything in the UI.
  await page.waitForTimeout(5000);
  assert.ok(reads >= 3);
  assert.equal(await page.locator('.local-service-error').count(), 0);
  for (const method of ['authorization', 'seller.status']) {
    blocked = method;
    await footer.getByText('桌面连接响应超时', { exact: true }).waitFor({ timeout: 10000 });
    await page.locator('.local-service-error').filter({ hasText: '桌面状态暂未响应' }).waitFor();
    const before = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 200);
    const elapsedMs = Math.round(performance.now() - before);
    assert.equal(service.status().status, 'running');
    const failedScreenshot = `${method.replace('.', '-')}-timeout.png`;
    await page.screenshot({ path: path.join(root, failedScreenshot) });
    blocked = '';
    for (const resolve of replies.splice(0)) resolve();
    await footer.getByText('运行正常', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.local-service-error').count(), 0);
    assert.deepEqual(fs.readFileSync(file), original);
    checks.push({ method, healthMs: elapsedMs, recovered: true });
  }
  assert.equal(writes, 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(root, 'idle-recovered.png') });
  console.log(JSON.stringify({ ok: true, root, reads, writes, checks, unchangedWorkspace: true }));
} finally {
  for (const resolve of replies.splice(0)) resolve();
  await browser?.close();
  await service.terminate();
  fs.rmSync(file, { force: true });
}
