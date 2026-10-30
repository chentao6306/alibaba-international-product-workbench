import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { constants } from 'node:buffer';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { startLocalService } from '../electron/local-service.js';
import { syncProductModel, verifySourceIntegrity } from '../server/product-model.js';
import { readWorkspace } from '../server/workspace-reader.js';
import { cleanupWorkspace } from '../server/storage-cleanup.js';

// Only generated data in a dedicated directory. No seller login or publication.
const count = 520;
const payload = 'Legacy description 中文 😀 '.padEnd(1024 * 1024, 'x');
const mode = process.argv[2];
const root = mode === '--child' ? process.argv[3] : fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-startup-'));
const file = path.join(root, 'workspace.json');
if (mode !== '--child') {
  const descriptor = fs.openSync(file, 'wx');
  try {
    fs.writeSync(descriptor, '{"version":6,"products":[');
    for (let index = 0; index < count; index++) {
      const product = syncProductModel({ id: String(index), title: `Fixture ${index}`, sourcePlatform: 'alibaba.com',
        categoryId: '201346401', collectionFolderId: 'fixture', price: 5, stock: 20, moq: 1, origin: 'China',
        mainImages: ['https://example.com/main.jpg'], detailImages: ['https://example.com/detail.jpg'],
        descriptionHtml: '<p>Original details</p>', status: 'ready', selected: false });
      product.auditTrail = [{ id: 'legacy', before: { descriptionHtml: payload }, after: { title: product.title } }];
      fs.writeSync(descriptor, (index ? ',' : '') + JSON.stringify(product));
    }
    fs.writeSync(descriptor, '],"jobs":[{"id":"paused-task","type":"publish","status":"paused","progress":1,"total":2,"metadata":{"productIds":["518","519"]}}],"settings":{"uploadProductVideos":false},"shops":[],"groups":[],"collectionFolders":[{"id":"fixture","name":"Fixture"}]}');
  } finally { fs.closeSync(descriptor); }
  const bytes = fs.statSync(file).size;
  assert.ok(bytes > constants.MAX_STRING_LENGTH);
  console.log(JSON.stringify({ stage: 'fixture', root, bytes, stringLimit: constants.MAX_STRING_LENGTH }));
  for (const stage of ['old-reader', 'service-first', 'service-restart', 'verify']) {
    const child = spawn(process.execPath, ['--max-old-space-size=2560', fileURLToPath(import.meta.url), '--child', root, stage],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; process.stdout.write(data); });
    child.stderr.on('data', data => { output += data; process.stderr.write(data); });
    const timer = setTimeout(() => child.kill(), 240000);
    const [code] = await once(child, 'exit'); clearTimeout(timer);
    fs.writeFileSync(path.join(root, stage + '.log'), output);
    assert.equal(code, 0, `${stage} failed; evidence: ${root}`);
  }
  console.log(JSON.stringify({ ok: true, root, bytes, count }));
} else {
  const stage = process.argv[4];
  const started = Date.now();
  if (stage === 'old-reader') {
    assert.throws(() => JSON.parse(fs.readFileSync(file, 'utf8')), error => {
      assert.equal(error.code, 'ERR_STRING_TOO_LONG');
      assert.match(error.message, /Cannot create a string longer/);
      console.log(JSON.stringify({ stage, reproduced: error.message })); return true;
    });
  } else if (stage === 'verify') {
    const state = readWorkspace(file);
    assert.equal(state.products.length, count);
    for (let index = 0; index < count; index++) {
      const product = state.products[index];
      assert.equal(product.id, String(index));
      assert.ok(product.auditTrail.find(entry => entry.id === 'legacy')?.before.descriptionHtml === payload, `History retained for ${index}`);
      assert.equal(product.source.snapshot.title, `Fixture ${index}`);
      assert.equal(verifySourceIntegrity(product).valid, true);
      assert.equal(product.price, index === 0 ? 19 : 5);
    }
    assert.equal(state.settings.uploadProductVideos, true);
    assert.equal(state.jobs[0].status, 'paused');
    assert.equal(state.jobs[0].progress, 1);
    // Check the media reference guard on the same oversized data. Keep every
    // actual product and paused task; this adapter only supplies a test view.
    const maintenance = { read: () => ({ ...state, jobs: [] }) };
    assert.equal(cleanupWorkspace(maintenance, root, { scopes: ['media'], confirm: true }).ok, true);
    state.products.at(-1).mainImages.push('/media/keep.jpg');
    assert.throws(() => cleanupWorkspace(maintenance, root, { scopes: ['media'], confirm: true }), /仍被商品引用/);
    console.log(JSON.stringify({ stage, checkedProducts: count, milliseconds: Date.now() - started, memory: process.memoryUsage() }));
  } else {
    let peakRss = 0, ticks = 0;
    const ticker = setInterval(() => { ticks++; peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
    const service = startLocalService({ entry: path.resolve('server/index.js'),
      env: { ...process.env, DATA_DIR: root, PORT: '0', KUA_YIPU_DESKTOP: '1', KUA_YIPU_LOCAL_GATE: 'fixture-gate' },
      handlers: { authorization: () => ({ valid: true, canRead: true, account: 'fixture' }),
        'secure.encrypt': value => Buffer.from(value), 'secure.decrypt': value => Buffer.from(value).toString(),
        'seller.status': () => ({ browserOpen: false }) } });
    try {
      const port = await service.ready;
      const startupMs = Date.now() - started;
      console.log(JSON.stringify({ stage, ready: true, startupMs, peakRss, windowThreadTicks: ticks }));
      const api = async (route, body) => {
        const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: body ? 'PATCH' : 'GET',
          headers: { 'content-type': 'application/json', 'x-kua-yipu-gate': 'fixture-gate' },
          ...(body ? { body: JSON.stringify(body) } : {}) });
        const value = await response.json(); assert.equal(response.status, 200, value.error); return value;
      };
      const summary = await api('/api/state?view=summary');
      assert.equal(summary.products.length, count);
      assert.equal(summary.jobs[0].status, 'paused');
      const product = await api('/api/products/0');
      assert.ok(product.auditTrail.find(entry => entry.id === 'legacy')?.before.descriptionHtml === payload, 'History retained after restart');
      if (stage === 'service-first') {
        assert.equal((await api('/api/products/0', { price: 19 })).price, 19);
        assert.equal((await api('/api/settings', { uploadProductVideos: true })).uploadProductVideos, true);
      } else {
        assert.equal(product.price, 19);
        assert.equal(summary.settings.uploadProductVideos, true);
      }
      console.log(JSON.stringify({ stage, ok: true, milliseconds: Date.now() - started, peakRss, windowThreadTicks: ticks }));
    } finally { clearInterval(ticker); await service.call('shutdownServer').catch(() => {}); await service.terminate(); }
  }
}
