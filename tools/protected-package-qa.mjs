import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import electron from 'electron';
import { listPackage, extractFile } from '@electron/asar';
import assert from 'node:assert/strict';

const application = path.resolve(process.argv[2] || 'release-installer/win-unpacked');
const archive = path.join(application, 'resources', 'app.asar');
const entries = listPackage(archive).map((name) => name.replaceAll('\\', '/'));
const encrypted = entries.filter((name) => /^\/(server|electron)\/.*\.js\.bin$/.test(name));
assert.ok(encrypted.length >= 70);
for (const file of encrypted) {
  const source = extractFile(archive, file.slice(1));
  assert.equal(source.subarray(0, 8).toString(), 'CDKENC01', file);
  assert.equal(extractFile(archive, file.slice(1, -4)).toString(), "throw new Error('请通过抄得快桌面程序启动');\n");
}
assert.equal(entries.some((name) => /^\/(server|electron|dist)\/.*\.map$/.test(name)), false);
assert.ok(extractFile(archive, 'electron/protected-loader.jsc').length > 1000);
const stage = fs.mkdtempSync(path.resolve('.data', 'protected-qa-'));
const selected = ['source-collection', 'cross-category-attributes', 'attribute-commit', 'multi-text-attributes', 'alibaba-login', 'logistics-policy', 'sku-reference', 'made-in-china', 'human-verification'];
const files = [];
for (const name of selected) {
  const original = fs.readFileSync(`test/${name}.test.js`, 'utf8');
  const source = original.replace(/(['"])\.\.\/(server|electron|src)\//g, (_match, quote, directory) => quote + pathToFileURL(directory === 'src' ? path.resolve(directory) : path.join(archive, directory)).href + '/');
  const file = path.join(stage, name + '.test.mjs');
  fs.writeFileSync(file, source); files.push(file);
}
fs.writeFileSync(path.join(stage, 'worker.cjs'), `
const { parentPort, workerData } = require('node:worker_threads');
const { run } = require('node:test');
require(${JSON.stringify(path.resolve('node_modules/bytenode'))});
require(${JSON.stringify(path.join(archive, 'electron/protected-loader.jsc'))})(${JSON.stringify(archive)});
process.resourcesPath = ${JSON.stringify(path.join(application, 'resources'))};
let passed = 0, failed = 0, skipped = 0;
const stream = run({ files: ${JSON.stringify(files)}, isolation: 'none', concurrency: 1 });
stream.on('test:pass', function(data) { if (data.skip) skipped++; else passed++; });
stream.on('test:fail', function(data) { failed++; console.error(data.name, data.details?.error); });
stream.on('error', function(error) { failed++; console.error(error); });
stream.on('data', function() {});
stream.on('end', function() { parentPort.postMessage({ passed, failed, skipped }); });
`);
fs.writeFileSync(path.join(stage, 'main.cjs'), `
const { app } = require('electron');
const { Worker } = require('node:worker_threads');
app.setPath('userData', ${JSON.stringify(path.join(stage, 'profile'))});
app.disableHardwareAcceleration();
app.whenReady().then(function() {
  // Check the exact packaged loader in both Electron's window and API threads.
  require(${JSON.stringify(path.resolve('node_modules/bytenode'))});
  require(${JSON.stringify(path.join(archive, 'electron/protected-loader.jsc'))})(${JSON.stringify(archive)});
  const worker = new Worker(${JSON.stringify(path.join(stage, 'worker.cjs'))});
  worker.on('error', function(error) { console.error(error); app.exit(1); });
  worker.on('message', function(result) { console.log(JSON.stringify(result)); worker.terminate().then(function() { app.exit(result.failed || !result.passed || result.skipped ? 1 : 0); }); });
});
`);
let child;
try {
  child = spawn(electron, [path.join(stage, 'main.cjs')], { windowsHide: true, stdio: 'inherit', env: { ...process.env, DATA_DIR: path.join(stage, 'data'), APP_ROOT_DIR: process.cwd(), KUA_YIPU_REQUIRE_BUNDLED_BROWSER: '1' } });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, 'Encrypted production module regression tests failed');
  console.log(`Verified ${encrypted.length} encrypted business modules against the actual packaged archive.`);
} finally {
  if (child?.exitCode === null) child.kill();
  // Keep test logs outside the source and remove only this generated directory.
  fs.rmSync(stage, { recursive: true, force: true });
}
