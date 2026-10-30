// Operate the actual protected desktop EXE through its normal renderer and API.
// Only disposable products are changed. The authorized seller session is copied
// into the temporary profile; no authentication or publishing check is bypassed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { syncProductModel, verifySourceIntegrity } from '../server/product-model.js';

const application = path.resolve(process.argv[2]);
const origin = process.env.QA_DESKTOP_USER_DATA_DIR;
const account = process.env.QA_EXPECTED_ACCOUNT;
assert.ok(origin && account, 'Explicit authorized desktop profile and account required');
const restartOnly = Boolean(process.env.QA_WATERMARK_RESTART_ROOT);
const root = restartOnly ? path.resolve(process.env.QA_WATERMARK_RESTART_ROOT) : fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-watermark-soak-'));
if (restartOnly) assert.ok(root.startsWith(path.join(os.tmpdir(), 'packaged-watermark-soak-')) && fs.existsSync(path.join(root, 'report.json')));
const reportFile = path.join(root, restartOnly ? 'restart-report.json' : 'report.json');
const profile = path.join(root, 'profile'), data = path.join(profile, '.data'), media = path.join(data, 'media');
fs.mkdirSync(media, { recursive: true });
const workspace = path.join(data, 'workspace.json');
const executable = path.join(application, '抄得快.exe');
assert.ok(fs.existsSync(executable));
const report = { root, application, checks: [], batches: [], failures: [], startedAt: new Date().toISOString() };
const record = (name, details = {}) => { report.checks.push({ name, ...details }); console.log(JSON.stringify({ check: name, ...details })); fs.writeFileSync(reportFile, JSON.stringify(report, null, 2)); };
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const durableDigest = product => {
  const copy = structuredClone(product);
  if (copy.quality) delete copy.quality.checkedAt; // Recomputed audit time changes on every startup.
  return digest(copy);
};
const batchCount = Number(process.env.QA_WATERMARK_BATCH_COUNT || 225);
assert.ok(batchCount > 200);
const poolCount = 12;
for (const file of ['Local State', 'credentials.bin', 'activation-credentials.bin', 'device-id']) {
  if (fs.existsSync(path.join(origin, file))) fs.copyFileSync(path.join(origin, file), path.join(profile, file));
}
// The user's active app may lock its Cookies database. Reuse its encrypted
// session export in a separate profile; normal login and authorization below
// still validate the copied session against the real platform and auth server.
const seed = spawn(process.execPath, ['node_modules/electron/cli.js', 'tools/seed-packaged-session-qa.mjs'], {
  windowsHide: true, stdio: 'inherit', env: { ...process.env, QA_SEED_PROFILE: profile },
});
const seedCode = await new Promise((resolve, reject) => { seed.once('error', reject); seed.once('exit', resolve); });
assert.equal(seedCode, 0, 'Could not prepare the isolated authorized session');
// Mixed dimensions exercise native decoding, resizing and compositing. Every
// pool member has different pixels; only shared source URLs are deduplicated.
if (!restartOnly) {
for (let i = 0; i < poolCount; i++) {
  for (const [kind, count] of [['main', 6], ['detail', 4]]) for (let j = 0; j < count; j++) {
    const [width, height] = kind === 'main' ? [[512, 512], [2400, 1600], [6000, 4000]][i % 3]
      : [[800, 600], [1600, 10000], [2000, 12000]][i % 3];
    const svg = `<svg width="800" height="600" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop stop-color="hsl(${i * 29 + j * 7},70%,30%)"/><stop offset="1" stop-color="hsl(${i * 17 + j * 41},65%,80%)"/></linearGradient></defs><rect width="800" height="600" fill="url(#g)"/>${Array.from({ length: 24 }, (_, n) => `<circle cx="${(n * 83 + i * 47) % 800}" cy="${(n * 73 + j * 61) % 600}" r="${15 + n}" fill="none" stroke="#ffffff" stroke-width="3"/>`).join('')}</svg>`;
    await sharp(Buffer.from(svg)).resize(width, height).jpeg({ quality: 88 }).toFile(path.join(media, `${kind}-${i}-${j}.jpg`));
  }
}
await sharp(Buffer.from('<svg width="300" height="180" xmlns="http://www.w3.org/2000/svg"><rect x="12" y="12" rx="25" width="276" height="156" fill="#0c7b7d"/><path d="M60 85h170M150 35v110" stroke="#ffffff" stroke-width="15"/></svg>')).png().toFile(path.join(root, 'logo.png'));
fs.writeFileSync(path.join(media, 'recoverable.jpg'), 'deliberately corrupt QA fixture');
const fd = fs.openSync(workspace, 'w');
fs.writeSync(fd, '{"version":5,"products":[');
let first = true;
for (const folder of ['mainImages', 'detailImages', 'both']) for (let i = 0; i < batchCount; i++) {
  const mainImages = Array.from({ length: 6 }, (_, j) => `/media/main-${i % poolCount}-${j}.jpg`);
  if (folder === 'mainImages' && i === 0) mainImages[0] = '/media/recoverable.jpg';
  const detailImages = Array.from({ length: 4 }, (_, j) => `/media/detail-${i % poolCount}-${j}.jpg`);
  const product = syncProductModel({ id: `${folder}-${i}`, sourceId: `${folder}-${i}`, title: `QA ${folder} 商品 ${i}`, sourcePlatform: 'alibaba.com',
    collectionFolderId: folder, selected: true, status: 'ready', categoryId: '202055012', price: 10, mainImages, detailImages,
    descriptionHtml: `<p>QA ${'legacy description '.repeat(700)}</p><table><tr><td>Preserve text</td></tr></table>${detailImages.map(url => `<img src="${url}">`).join('')}` });
  product.auditTrail = Array.from({ length: 2 }, (_, n) => ({ id: `legacy-${n}`, fields: ['title'], before: { ...product.working }, after: { ...product.working } }));
  fs.writeSync(fd, (first ? '' : ',') + JSON.stringify(product)); first = false;
}
fs.writeSync(fd, ',{"id":"unselected-sentinel","title":"Do not edit","selected":false,"collectionFolderId":"sentinel","mainImages":[],"detailImages":[]}]');
fs.writeSync(fd, ',"settings":{"activeCollectionFolderId":"mainImages","publishBindings":{}},"shops":[],"groups":[],"jobs":[],"collectionFolders":' + JSON.stringify(['mainImages', 'detailImages', 'both', 'sentinel'].map(id => ({ id, name: id }))) + '}');
fs.closeSync(fd);
record('legacy-workspace-seeded', { products: batchCount * 3, bytes: fs.statSync(workspace).size, uniqueImages: poolCount * 10 });
}
const read = () => JSON.parse(fs.readFileSync(workspace, 'utf8'));
const sourceHashes = new Map(read().products.filter(p => p.source).map(p => [p.id, digest(p.source)]));
const initialSentinel = digest(read().products.find(p => p.id === 'unselected-sentinel'));
let child, browser, page, timer, sampling = false;
let peakRootWorkingSet = 0, peakTreeWorkingSet = 0;
const browserErrors = [];
async function freePort() {
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port;
}
async function start() {
  const debugPort = await freePort(), apiPort = await freePort();
  const output = fs.openSync(path.join(root, 'desktop.log'), 'a');
  child = spawn(executable, [`--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'],
    { windowsHide: true, stdio: ['ignore', output, output], env: { ...process.env, APPDATA: root, LOCALAPPDATA: root, KUA_YIPU_PORT: String(apiPort) } });
  fs.closeSync(output);
  for (let i = 0; i < 120; i++) {
    assert.equal(child.exitCode, null, 'Actual packaged EXE exited');
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
    if (response?.ok) { browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`); break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(browser);
  let login;
  for (let i = 0; i < 100; i++) {
    login = browser.contexts().flatMap(context => context.pages()).find(p => p.url().endsWith('/login.html'));
    if (login) break; await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(login); await login.locator('#login').waitFor();
  await login.locator('#username').fill(account);
  // A valid copied seller session is checked before any password submission.
  // Never log credentials or put a real password in the harness/artifact.
  await login.evaluate(async account => {
    const saved = await window.kuaYipu.loadCredentials();
    document.querySelector('#password').value = saved?.username === account && saved.password ? saved.password : 'session-reuse-only';
  }, account);
  await login.locator('#remember').check(); await login.locator('#login').click();
  console.log(JSON.stringify({ phase: 'normal-packaged-login', root }));
  for (let i = 0; i < 1800; i++) {
    page = browser.contexts().flatMap(context => context.pages()).find(p => p.url() === `http://127.0.0.1:${apiPort}/`);
    if (page) break;
    if (i % 30 === 0) console.log(JSON.stringify({ phase: 'login-wait',
      button: login.isClosed() ? 'closed' : await login.locator('#login').textContent(),
      notice: login.isClosed() ? '' : await login.locator('#error').textContent(),
      pages: await Promise.all(browser.contexts().flatMap(context => context.pages()).map(async p => {
        const url = new URL(p.url()); return { host: url.host, path: url.protocol === 'data:' ? 'loading-or-error' : url.pathname, title: await p.title().catch(() => '') };
      })),
    }));
    if (!login.isClosed() && await login.locator('#login').textContent() === '进入系统') await login.locator('#login').click();
    if (!login.isClosed() && await login.locator('#login').textContent() === '登录' && await login.locator('#login').isEnabled()) throw Error(await login.locator('#error').textContent());
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(page, 'Normal packaged login did not enter workbench');
  page.setDefaultTimeout(30000); page.on('pageerror', error => browserErrors.push(error.message));
  await page.locator('.sidebar').waitFor();
  // Read-only announcements may be dismissed like a first-time user.
  const announcement = page.getByRole('dialog', { name: '公告', exact: true });
  await announcement.waitFor({ timeout: 5000 }).catch(() => {});
  for (let i = 0; i < 20 && await announcement.isVisible(); i++) {
    await announcement.getByRole('button', { name: '我已阅读', exact: true }).click();
    await announcement.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }
  record('actual-exe-authenticated-and-service-ready', { unauthenticatedApiStatus: (await fetch(`http://127.0.0.1:${apiPort}/api/state`)).status });
  timer = setInterval(async () => {
    if (sampling || child?.exitCode !== null) return;
    sampling = true;
    try {
      const script = `$all=Get-CimInstance Win32_Process; $ids=@(${child.pid}); do { $next=@($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | ForEach-Object { $_.ProcessId }); $ids+=$next } while($next.Count); $p=@(Get-Process -Id $ids -ErrorAction SilentlyContinue); [pscustomobject]@{ root=(Get-Process -Id ${child.pid}).WorkingSet64; tree=($p | Measure-Object WorkingSet64 -Sum).Sum } | ConvertTo-Json -Compress`;
      const monitor = spawn('powershell', ['-NoProfile', '-Command', script], { windowsHide: true });
      let text = ''; monitor.stdout.on('data', chunk => { text += chunk; });
      await new Promise(resolve => monitor.once('exit', resolve));
      const sample = JSON.parse(text); peakRootWorkingSet = Math.max(peakRootWorkingSet, sample.root); peakTreeWorkingSet = Math.max(peakTreeWorkingSet, sample.tree);
      fs.appendFileSync(path.join(root, 'memory.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...sample }) + '\n');
    } catch {} finally { sampling = false; }
  }, 5000);
}
async function stop() {
  clearInterval(timer);
  await browser?.close().catch(() => {}); browser = null;
  if (child && child.exitCode === null) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} }
  child = null;
}
try {
  await start();
  await page.locator('.sidebar nav button').filter({ hasText: '设置' }).click();
  await page.getByRole('switch', { name: '成功发布后自动删除工作台商品' }).check();
  await page.getByText('已开启成功发布后自动删除', { exact: true }).waitFor();
  assert.equal(read().settings.autoRemovePublishedProducts, true);
  record('packaged-published-cleanup-setting-enabled');
  await page.locator('.sidebar nav button').filter({ hasText: '商品工作台' }).click();
  const editor = page.getByRole('region', { name: '批量图片编辑', exact: true });
  const settled = () => page.waitForFunction(() => !document.querySelector('.batch-image-editor [role="status"]'), null, { timeout: 20 * 60 * 1000 });
  for (const type of restartOnly ? [] : ['image', 'text']) for (const scope of ['mainImages', 'detailImages', 'both']) {
    await page.getByLabel('采集分组', { exact: true }).selectOption(scope);
    await page.getByRole('button', { name: `批量修改 ${batchCount}`, exact: true }).click();
    const title = page.getByLabel('标题前缀', { exact: true });
    await title.click(); await page.keyboard.type('Do not save basic fields'); assert.equal(await title.inputValue(), 'Do not save basic fields');
    await page.locator('.batch-tabs').getByRole('button', { name: '产品图片', exact: true }).click(); await editor.waitFor(); await settled();
    assert.equal(await editor.getByLabel('预览商品', { exact: true }).locator('option').count(), batchCount);
    await editor.getByLabel('水印作用范围', { exact: true }).selectOption(scope);
    await editor.getByLabel('水印类型', { exact: true }).selectOption(type);
    if (type === 'image') {
      await editor.getByLabel('上传水印图片', { exact: true }).setInputFiles(path.join(root, 'logo.png')); await settled();
    } else {
      const input = editor.getByLabel('水印文字', { exact: true }); await input.click(); await page.keyboard.type('COPYFAST QA');
      assert.equal(await input.inputValue(), 'COPYFAST QA'); assert.equal(await input.evaluate(node => node === document.activeElement), true);
    }
    const before = new Map(read().products.map(p => [p.id, { mainImages: p.mainImages, detailImages: p.detailImages, descriptionHash: digest(p.descriptionHtml || '') }]));
    const started = Date.now();
    console.log(JSON.stringify({ phase: 'watermark-processing', type, scope, count: batchCount }));
    await editor.getByRole('button', { name: '一键添加／更新水印', exact: true }).click(); await settled();
    if (type === 'image' && scope === 'mainImages') {
      const failures = editor.getByRole('region', { name: '批量操作失败清单', exact: true });
      assert.match(await failures.innerText(), /mainImages-0.*主图 1/s);
      await failures.getByRole('button', { name: '查看商品', exact: true }).click();
      assert.equal(await editor.getByLabel('预览商品', { exact: true }).inputValue(), 'mainImages-0');
      fs.copyFileSync(path.join(media, 'main-0-0.jpg'), path.join(media, 'recoverable.jpg'));
      await failures.getByRole('button', { name: '只重试失败图片', exact: true }).click(); await settled();
      assert.equal(await failures.count(), 0); record('corrupt-image-localized-and-only-failed-image-retried');
    }
    assert.equal(await editor.locator('.batch-failures').count(), 0);
    assert.equal(await editor.locator('.bie-error').count(), 0);
    let requests = 0;
    const intercept = async route => {
      requests++;
      if (requests === 2) await route.fulfill({ status: 503, json: { error: 'QA save interruption' } });
      else await route.continue();
    };
    if (type === 'image' && scope === 'mainImages') await page.route('**/api/products/save-images', intercept);
    await editor.getByRole('button', { name: '保存图片修改', exact: true }).click();
    if (type === 'image' && scope === 'mainImages') {
      await settled();
      assert.match(await editor.locator('.bie-error').innerText(), /已保存 25 件商品/);
      await page.unroute('**/api/products/save-images', intercept);
      const count = read().products.filter(p => p.collectionFolderId === scope && p.imageEdits?.main).length;
      assert.equal(count, 25);
      await editor.getByRole('button', { name: '保存图片修改', exact: true }).click();
      record('interrupted-save-retains-first-25-and-retries-unsaved-products');
    }
    await editor.waitFor({ state: 'hidden', timeout: 180000 });
    const stored = read();
    for (const p of stored.products) {
      if (p.source) assert.equal(verifySourceIntegrity(p).valid, true);
      if (sourceHashes.has(p.id)) assert.equal(digest(p.source), sourceHashes.get(p.id), `Source changed for ${p.id}`);
      if (p.collectionFolderId !== scope) {
        assert.deepEqual(p.mainImages, before.get(p.id).mainImages); assert.deepEqual(p.detailImages, before.get(p.id).detailImages); continue;
      }
      for (const key of ['mainImages', 'detailImages']) {
        if (scope === 'both' || scope === key) assert.notDeepEqual(p[key], before.get(p.id)[key]); else assert.deepEqual(p[key], before.get(p.id)[key]);
        for (const url of p[key]) assert.ok(fs.existsSync(path.join(media, path.basename(url))));
      }
      if (scope === 'mainImages') assert.equal(digest(p.descriptionHtml), before.get(p.id).descriptionHash);
      else for (const url of p.detailImages) assert.ok(p.descriptionHtml.includes(url));
      assert.ok(p.title.startsWith('QA '));
    }
    const result = { type, scope, products: batchCount, milliseconds: Date.now() - started, peakRootWorkingSet, peakTreeWorkingSet };
    report.batches.push(result); record('watermark-batch-persisted', result);
    // Exercise the next edit before capturing: a saved file alone does not
    // prove that Electron's renderer is still interactive after a large batch.
    await page.getByRole('button', { name: `批量修改 ${batchCount}`, exact: true }).click();
    const nextTitle = page.getByLabel('标题前缀', { exact: true });
    await nextTitle.fill('Next batch responds');
    assert.equal(await nextTitle.inputValue(), 'Next batch responds');
    await page.locator('.drawer-header-actions').getByRole('button', { name: '关闭', exact: true }).click();
    await page.bringToFront();
    const screenshot = path.join(root, `${type}-${scope}-saved.png`); await page.screenshot({ path: screenshot, timeout: 60000 });
    record('next-batch-input-and-capture-responsive', { type, scope });
  }
  // Force process exit only after durable saves, then run the same EXE and normal
  // login again. All data, source snapshots and revisions must survive restart.
  const beforeRestart = new Map(read().products.map(p => [p.id, durableDigest(p)]));
  await stop(); await start();
  for (const p of read().products) assert.equal(durableDigest(p), beforeRestart.get(p.id), `Restart changed ${p.id}`);
  record('restart-preserves-every-product-and-edit-history');
  await page.locator('.sidebar nav button').filter({ hasText: '设置' }).click();
  const cleanup = page.getByRole('switch', { name: '成功发布后自动删除工作台商品' });
  assert.equal(await cleanup.isChecked(), true);
  await cleanup.uncheck();
  await page.getByText('已关闭成功发布后自动删除', { exact: true }).waitFor();
  await stop(); await start();
  await page.locator('.sidebar nav button').filter({ hasText: '设置' }).click();
  assert.equal(await page.getByRole('switch', { name: '成功发布后自动删除工作台商品' }).isChecked(), false);
  record('packaged-published-cleanup-on-and-off-survive-restart');
  assert.deepEqual(browserErrors, []);
  // Startup may add schema defaults to the untouched sentinel, so compare its
  // user-controlled fields rather than asserting byte identity across migration.
  const sentinel = read().products.find(p => p.id === 'unselected-sentinel');
  assert.equal(sentinel.title, 'Do not edit'); assert.deepEqual(sentinel.mainImages, []);
  report.ok = true; report.finishedAt = new Date().toISOString();
  record('completed', { peakRootWorkingSet, peakTreeWorkingSet, browserErrors: 0, initialSentinel });
} catch (error) {
  report.ok = false; report.failures.push(error.message);
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.error(JSON.stringify({ root, error: error.message })); process.exitCode = 1;
} finally {
  await stop();
  // Keep product fixtures/reports, remove only copied authentication material.
  for (const file of ['Local State', 'credentials.bin', 'activation-credentials.bin', 'device-id', 'alibaba-cookies.json', 'alibaba-storage.json']) fs.rmSync(path.join(profile, file), { force: true });
  fs.rmSync(path.join(profile, 'Partitions'), { force: true, recursive: true, maxRetries: 20, retryDelay: 200 });
}
