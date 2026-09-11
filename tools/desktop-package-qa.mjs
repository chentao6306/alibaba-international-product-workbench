import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { extractFile, listPackage } from '@electron/asar';
import { getCurrentFuseWire, FuseV1Options } from '@electron/fuses';

const release = path.resolve(process.argv[2]);
const asar = path.join(release, 'win-unpacked/resources/app.asar');
const metadata = JSON.parse(fs.readFileSync('package.json', 'utf8'));
assert.equal(JSON.parse(extractFile(asar, 'package.json')).version, metadata.version);
const entries = listPackage(asar);
assert.equal(entries.some((entry) => /(?:^|\/)(?:\.data|\.env|credentials\.bin|alibaba-cookies\.json)(?:\/|$)/.test(entry)), false);
for (const folder of ['server', 'electron']) {
  const packagedFolder = path.join('.packaged', folder);
  for (const name of fs.readdirSync(packagedFolder)) {
    const file = `${folder}/${name}`;
    if (fs.statSync(path.join(packagedFolder, name)).isFile()) {
      assert.ok(extractFile(asar, file).equals(fs.readFileSync(path.join(packagedFolder, name))), `Packaged source differs: ${file}`);
    }
  }
}
assert.ok(fs.statSync(path.join(release, 'win-unpacked/resources/chromium/chrome.exe')).size > 1000000);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-package-qa-'));
const executable = fs.readdirSync(path.join(release, 'win-unpacked')).find((name) => name.endsWith('.exe'));
const executablePath = path.join(release, 'win-unpacked', executable);
const fuses = await getCurrentFuseWire(executablePath);
for (const name of ['RunAsNode', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments']) assert.equal(fuses[FuseV1Options[name]], 48, name);
for (const name of ['EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar', 'EnableCookieEncryption']) assert.equal(fuses[FuseV1Options[name]], 49, name);
async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}
const debugPort = await freePort();
const apiPort = await freePort();
// Renderer CDP does not require the main-process Node inspector disabled by fuses.
const child = spawn(executablePath, [`--user-data-dir=${path.join(root, 'profile')}`, `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, APPDATA: root, LOCALAPPDATA: root, KUA_YIPU_PORT: String(apiPort) } });
let browser;
try {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`Packaged app exited: ${child.exitCode}`);
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
    if (response?.ok) { browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`); break; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(browser, 'Packaged renderer did not start');
  let window;
  for (let attempt = 0; attempt < 40; attempt++) {
    window = browser.contexts().flatMap((context) => context.pages()).find((page) => page.url().endsWith('/login.html'));
    if (window) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(window, 'Login window did not load');
  await window.locator('#login').waitFor();
  assert.equal(await window.locator('#login').isEnabled(), true);
  await window.evaluate(() => window.kuaYipu.loadCredentials());
  assert.equal(await window.locator('#error').textContent(), '');
  assert.equal((await fetch(`http://127.0.0.1:${apiPort}/health`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${apiPort}/api/state`)).status, 401);
  await window.screenshot({ path: path.join(root, 'packaged-login.png') });
} finally {
  await browser?.close();
  if (child.exitCode === null) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} }
}
const installer = path.join(release, `chaodekuai-${metadata.version}-setup.exe`);
console.log(JSON.stringify({ version: metadata.version, installer, bytes: fs.statSync(installer).size, sha256: createHash('sha256').update(fs.readFileSync(installer)).digest('hex'), screenshot: path.join(root, 'packaged-login.png') }));
