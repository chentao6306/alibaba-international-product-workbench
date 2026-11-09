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
const available = ['collection-folders', 'source-collection', 'cross-category-attributes', 'attribute-commit', 'multi-text-attributes', 'alibaba-login', 'logistics-policy', 'sku-reference', 'made-in-china', 'human-verification', 'origin-packaging', 'source-attribute-priority', 'description-image-upload', 'publish-form-regression', 'posting-interaction', 'main-image-validation', 'product-publish-display', 'posting-extras', 'posting-video', 'posting-customization-media', 'published-video-retry'];
available.push('attribute-choice-regression', 'attribute-publishing-regressions', 'publish-category-entry', 'category-catalog', 'posting-readiness');
available.push('video-upload-setting', 'native-browser-window');
available.push('main-image-recovery', 'browser-error', 'publish-readiness-jobs', 'publish-specification-feedback');
available.push('large-watermark-output', 'tall-description-image', 'published-edit-state', 'refresh-detail-concurrency');
available.push('workbench-startup');
available.push('posting-language');
available.push('product-transfer');
available.push('workspace-reader', 'workspace-clone', 'storage-failure', 'image-save-memory', 'store-progress', 'workbench-state');
available.push('local-service-large-workspace');
available.push('color-spec-enablement', 'sale-spec-reset', 'collection-control', 'attribute-transfer', 'structured-description', 'product-fidelity', 'batch-text');
available.push('sales-unit', 'publish-price-tiers');
available.push('collection-unavailable', 'collection-resume-api', 'collection-checkpoint', 'collection-pagination');
available.push('packaging-attributes', 'description-structure', 'native-description-fields', 'window-lifecycle', 'software-updates');
available.push('customer-flower-publishing', 'generic-posting', 'publish-reference');
available.push('ai-product-assistance', 'ai-product-workflow', 'ai-publishing');
available.push('packaging-use-evidence');
available.push('collection-product-links', 'publish-stall-jobs');
available.push('structured-description-images', 'native-media-flow', 'origin-literal');
available.push('custom-attribute-capacity', 'spec-token-commit', 'delivery-sheet-regression');
available.push('attribute-table-layout', 'category-field-visibility');
available.push('lighting-attributes', 'lighting-weight');
available.push('description-mode');
available.push('description-compatibility');
available.push('image-upload-alpha', 'image-download-retry', 'publish-media-integrity');
available.push('sku-options', 'sku-options-workflow');
available.push('sku-identity-boundaries', 'action-receipt-freshness');
available.push('sku-source-recovery');
available.push('posting-navigation', 'publish-background-browser');
available.push('authorization-task-pause', 'collection-stall-api');
available.push('reference-scale', 'reference-workflow', 'spec-image-dimension', 'diagnostics', 'local-api');
available.push('gallery-name-preservation');
available.push('faq-control-recovery');
available.push('sku-dimensions');
available.push('ai-service-availability', 'structured-upload-entry');
available.push('publish-late-receipt');
available.push('custom-attribute-name', 'reference-responsive', 'local-state-recovery', 'local-service-idle');
const requested = process.argv.slice(3);
assert.ok(requested.every(name => available.includes(name)), 'Unknown package regression selection');
const selected = requested.length ? requested : available;
const files = [];
for (const name of selected) {
  const original = fs.readFileSync(`test/${name}.test.js`, 'utf8');
  const source = original.replace(/(['"])\.\.\/(server|electron|src|auth-server)\//g, (_match, quote, directory) => quote + pathToFileURL(['src', 'auth-server'].includes(directory) ? path.resolve(directory) : path.join(archive, directory)).href + '/');
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
const stream = run({ files: [workerData.file], isolation: 'none', concurrency: 1 });
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
app.whenReady().then(async function() {
  // Check the exact packaged loader in both Electron's window and API threads.
  require(${JSON.stringify(path.resolve('node_modules/bytenode'))});
  require(${JSON.stringify(path.join(archive, 'electron/protected-loader.jsc'))})(${JSON.stringify(archive)});
  // Each suite must get a fresh module cache and environment, as node --test
  // does by default. API suites import a singleton server tied to DATA_DIR;
  // sharing it makes a later suite inspect an already-closed unrelated store.
  const totals = { passed: 0, failed: 0, skipped: 0 };
  for (const file of ${JSON.stringify(files)}) {
    const result = await new Promise(function(resolve, reject) {
      const worker = new Worker(${JSON.stringify(path.join(stage, 'worker.cjs'))}, { workerData: { file } });
      let delivered = false;
      worker.once('error', reject);
      worker.once('exit', function(code) { if (!delivered) reject(new Error('Package test worker exited without results: ' + code)); });
      worker.once('message', function(result) {
        delivered = true;
        worker.terminate().then(function() { resolve(result); }, reject);
      });
    });
    for (const key of Object.keys(totals)) totals[key] += result[key];
    console.log(JSON.stringify({ suite: require('node:path').basename(file), ...result }));
  }
  console.log(JSON.stringify(totals));
  app.exit(totals.failed || !totals.passed || totals.skipped ? 1 : 0);
}).catch(function(error) {
  console.error(error); app.exit(1);
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
