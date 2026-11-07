import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SellerPublisher } from '../server/publisher.js';
import { hasExplicitHumanChallenge } from '../server/browser-runtime.js';

const productUrl = process.argv[2];
if (!productUrl) throw new Error('Provide a source product URL');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-live-qa-'));
process.env.DATA_DIR = root; process.env.PORT = '0';
let sourceContext;
const sourceBrowser = SellerPublisher.prototype.sourceBrowser;
SellerPublisher.prototype.sourceBrowser = async function () { sourceContext = await sourceBrowser.call(this); return sourceContext; };
const server = await import('../server/index.js');
const listener = await server.serverReady;
const url = `http://127.0.0.1:${listener.address().port}`;
async function request(route, body) {
  const response = await fetch(url + route, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
try {
  const a = await request('/api/collection-folders', { name: '实测采集' });
  const job = await request('/api/collect/links', { urls: productUrl, method: 'product', collectionFolderId: a.id, delaySeconds: 0 });
  const b = await request('/api/collection-folders', { name: '切换后的分组' });
  const deadline = Date.now() + 240000;
  let lastMessage = '';
  while (Date.now() < deadline) {
    const sourcePage = sourceContext?.pages().find((page) => /alibaba\.com/.test(page.url()));
    if (sourcePage && await hasExplicitHumanChallenge(sourcePage)) {
      const screenshot = path.join(root, 'source-verification.png');
      const captured = await sourcePage.screenshot({ path: screenshot, timeout: 5000 }).then(() => true).catch(() => false);
      throw new Error(`Source verification required${captured ? `; screenshot: ${screenshot}` : '; source browser switched to verification'}`);
    }
    const state = await request('/api/state');
    const current = state.jobs.find((item) => item.id === job.id);
    if (current.message !== lastMessage) { console.log(current.message); lastMessage = current.message; }
    if (['completed', 'failed', 'paused'].includes(current.status)) {
      assert.equal(current.status, 'completed', current.message);
      const products = state.products.filter((product) => product.collectionFolderId === a.id);
      assert.equal(products.length, 1);
      assert.equal(state.products.filter((product) => product.collectionFolderId === b.id).length, 0);
      assert.equal(state.settings.activeCollectionFolderId, b.id);
      console.log(JSON.stringify({ ok: true, root, sourceId: products[0].sourceId, images: products[0].mainImages?.length, details: products[0].detailImages?.length, folderIsolation: true }));
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (Date.now() >= deadline) throw new Error('Live collection timed out');
} finally { await server.shutdownServer(); SellerPublisher.prototype.sourceBrowser = sourceBrowser; }
