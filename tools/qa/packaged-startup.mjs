import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const root = process.env.QA_OUTPUT_DIR, origin = process.env.QA_DESKTOP_USER_DATA_DIR, account = process.env.QA_EXPECTED_ACCOUNT;
assert.ok(root && origin && account);
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-startup-'));
const profile = path.join(runtime, 'profile');
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(profile, { recursive: true });
for (const name of ['Local State', 'credentials.bin', 'activation-credentials.bin', 'device-id']) {
  if (fs.existsSync(path.join(origin, name))) fs.copyFileSync(path.join(origin, name), path.join(profile, name));
}
const seed = spawn(process.execPath, ['node_modules/electron/cli.js', 'tools/seed-packaged-session-qa.mjs'], {
  windowsHide: true, stdio: 'inherit', env: { ...process.env, QA_SEED_PROFILE: profile },
});
assert.equal(await new Promise((resolve, reject) => { seed.once('exit', resolve); seed.once('error', reject); }), 0);
async function port() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
const report = { version: '1.4.80', runs: [] };
let child, browser;
try {
  for (let attempt = 0; attempt < 2; attempt++) {
    const debugPort = await port(), apiPort = await port();
    child = spawn(path.resolve(process.argv[2], '抄得快.exe'), [`--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`], {
      windowsHide: true, stdio: 'ignore', env: { ...process.env, APPDATA: runtime, LOCALAPPDATA: runtime, KUA_YIPU_PORT: String(apiPort) },
    });
    const deadline = Date.now() + 180000;
    while (!browser && Date.now() < deadline) {
      assert.equal(child.exitCode, null);
      if ((await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null))?.ok) browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
      else await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert.ok(browser);
    const pages = () => browser.contexts().flatMap(context => context.pages());
    let login, main;
    while (!login && Date.now() < deadline) { login = pages().find(page => page.url().endsWith('/login.html')); if (!login) await new Promise(resolve => setTimeout(resolve, 200)); }
    assert.ok(login);
    await login.locator('#username').fill(account);
    await login.evaluate(async account => {
      const saved = await window.kuaYipu.loadCredentials();
      document.querySelector('#password').value = saved?.username === account && saved.password || 'session-reuse-only';
    }, account);
    await login.locator('#login').click();
    while (!main && Date.now() < deadline) {
      main = pages().find(page => page.url() === `http://127.0.0.1:${apiPort}/`);
      if (!main && !login.isClosed() && await login.locator('#login').textContent() === '进入系统') await login.locator('#login').click();
      if (!main) await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert.ok(main, 'Packaged normal login did not enter the workbench');
    await main.locator('.sidebar').waitFor({ timeout: 30000 });
    await main.evaluate(() => { window.qaUnsavedSentinel = 'retain through re-entry'; });
    await main.evaluate(() => Promise.all(Array.from({ length: 20 }, () => window.kuaYipu.enter())));
    assert.equal(await main.evaluate(() => window.qaUnsavedSentinel), 'retain through re-entry');
    assert.equal(await main.evaluate(async () => (await fetch('/api/state')).status), 200);
    assert.equal((await fetch(`http://127.0.0.1:${apiPort}/api/state`)).status, 401);
    await main.screenshot({ path: path.join(root, `workbench-${attempt + 1}.png`) });
    report.runs.push({ restart: attempt > 0, authorizedWorkbench: true, duplicateEntries: 20, noReload: true, anonymousApiRejected: true });
    await browser.close(); browser = null;
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    child = null;
  }
  report.ok = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  await browser?.close().catch(() => {});
  if (child) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} }
  fs.writeFileSync(path.join(root, 'packaged-startup.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
