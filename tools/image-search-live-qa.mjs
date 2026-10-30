// Real result-link collection through the API, with an isolated product store.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { app, session } from 'electron';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';
import { showHumanVerification } from '../electron/human-verification.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-search-live-'));
const source = JSON.parse(fs.readFileSync(process.env.QA_SOURCE_FILE));
const url = new URL('https://www.alibaba.com/search/page');
url.searchParams.set('SearchScene', 'imageTextSearch');
url.searchParams.set('imagePath', source.mainImages[0]);
const cookieFile = path.join(root, 'alibaba-cookies.json');
const cookies = readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json'));
writePrivateSession(cookieFile, cookies);
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = cookieFile;
process.env.DATA_DIR = root;
process.env.PORT = '0';
const partition = `image-search-qa-${Date.now()}`;
const browserSession = session.fromPartition(partition);
for (const cookie of cookies) {
  const domain = cookie.domain.replace(/^\./, '');
  if (/(^|\.)(alibaba\.com|alicdn\.com)$/.test(domain)) await browserSession.cookies.set({ ...cookie, url: `https://${domain}${cookie.path || '/'}` }).catch(() => {});
}
app.on('window-all-closed', () => {});
globalThis.__KUA_YIPU_SELLER_BRIDGE = { humanVerification: (address, options) => showHumanVerification({
  url: address, partition, ...options,
  saveSession: async ({ webContents }) => writePrivateSession(cookieFile, await webContents.session.cookies.get({})),
  onCreated: ({ window }) => window.on('show', () => console.log('以图搜品验证码窗口已显示，请用户完成验证')),
}) };
const server = await import('../server/index.js');
const listener = await server.serverReady;
const base = `http://127.0.0.1:${listener.address().port}`;
const report = { root, inputUrl: url.href, stages: [] };
const save = () => fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
async function request(route, body) {
  const response = await fetch(base + route, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await response.json();
  assert.ok(response.ok, data.error || `HTTP ${response.status}`);
  return data;
}
try {
  const folder = await request('/api/collection-folders', { name: '以图搜品现场验证' });
  const job = await request('/api/collect/links', { urls: url.href, platform: 'alibaba.com', method: 'image-search', collectionFolderId: folder.id, startPage: 1, endPage: 1, maxProducts: 1, delaySeconds: 0 });
  const other = await request('/api/collection-folders', { name: '采集期间切换的分组' });
  const deadline = Date.now() + 10 * 60 * 1000;
  let message = '';
  while (Date.now() < deadline) {
    const state = await request('/api/state');
    const current = state.jobs.find((item) => item.id === job.id);
    if (message !== current.message) { message = current.message; report.stages.push(message); save(); console.log(message); }
    if (['completed', 'failed', 'paused', 'cancelled'].includes(current.status)) {
      report.job = current;
      const products = state.products.filter((item) => item.collectionFolderId === folder.id);
      report.products = products.map((item) => ({ sourceId: item.sourceId, title: item.title, images: item.mainImages?.length, details: item.detailImages?.length, attributes: item.attributes?.length }));
      assert.equal(current.status, 'completed', current.message);
      assert.equal(products.length, 1, 'One real result must be collected');
      assert.ok(products[0].mainImages?.length && products[0].attributes?.length, 'Result details must be enriched');
      assert.equal(state.products.filter((item) => item.collectionFolderId === other.id).length, 0);
      assert.equal(state.settings.activeCollectionFolderId, other.id);
      report.ok = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(report.ok, true, 'Live image-search collection did not complete');
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally { await server.shutdownServer(); save(); console.log(JSON.stringify(report)); }
