import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { _electron } from 'playwright-core';
import { extractFile, listPackage } from '@electron/asar';

const release = path.resolve(process.argv[2]);
const asar = path.join(release, 'win-unpacked/resources/app.asar');
const metadata = JSON.parse(fs.readFileSync('package.json', 'utf8'));
assert.equal(JSON.parse(extractFile(asar, 'package.json')).version, metadata.version);
const entries = listPackage(asar);
assert.equal(entries.some((entry) => /(?:^|\/)(?:\.data|\.env|credentials\.bin|alibaba-cookies\.json)(?:\/|$)/.test(entry)), false);
for (const folder of ['server', 'electron']) {
  for (const name of fs.readdirSync(folder)) {
    const file = `${folder}/${name}`;
    if (fs.statSync(file).isFile()) assert.ok(extractFile(asar, file).equals(fs.readFileSync(file)), `Packaged source differs: ${file}`);
  }
}
assert.ok(fs.statSync(path.join(release, 'win-unpacked/resources/chromium/chrome.exe')).size > 1000000);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-package-qa-'));
const executable = fs.readdirSync(path.join(release, 'win-unpacked')).find((name) => name.endsWith('.exe'));
const app = await _electron.launch({ executablePath: path.join(release, 'win-unpacked', executable), args: [`--user-data-dir=${path.join(root, 'profile')}`], env: { ...process.env, APPDATA: root, LOCALAPPDATA: root } });
try {
  const window = await app.firstWindow();
  await window.locator('#login').waitFor();
  assert.equal(await window.locator('#login').isEnabled(), true);
  assert.equal(await window.locator('#error').textContent(), '');
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), metadata.version);
  const userData = await app.evaluate(({ app }) => app.getPath('userData'));
  assert.ok(path.resolve(userData).startsWith(root));
  await window.screenshot({ path: path.join(root, 'packaged-login.png') });
} finally { await app.close(); }
const installer = path.join(release, `chaodekuai-${metadata.version}-setup.exe`);
console.log(JSON.stringify({ version: metadata.version, installer, bytes: fs.statSync(installer).size, sha256: createHash('sha256').update(fs.readFileSync(installer)).digest('hex'), screenshot: path.join(root, 'packaged-login.png') }));
